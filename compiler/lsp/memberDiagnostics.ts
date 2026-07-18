import { NodeKind } from "compiler/ast/ast";
import { baseTypeName } from "compiler/analysis/typeNames";
import { arrayType, builtinType, namedType, UNKNOWN_TYPE } from "compiler/analysis/types";
import type { EnumStatement, Identifier } from "compiler/ast/ast";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "./diagnosticSeverity";
import type { AnalysisSession } from "./analysisSession";
import { arrayTypeNameToArrayAlias, boxedCompletionTypeName } from "./memberCompletionTypeNames";
import {
  type ClassResolverSessionLike,
  createClassResolverCache,
  resolveClassMember,
  resolveClassStatementAcrossFiles,
  resolveExpressionTypeName as resolveCrossFileExpressionTypeName
} from "./classResolver";
import { resolveExtensionMemberDeclarationAcrossFiles } from "./crossFileMemberDefinitionSources";
import { collectMemberExpressions } from "./crossFileTypeResolution";
import { VEXA_DIAGNOSTIC_CODES } from "./diagnosticCodes";
import { findTopLevelDeclarationInProgram } from "./declarationResolver";
import { uriToFilePath } from "./importFixes";
import { parseTypeNameShape } from "compiler/analysis/typeNames";

function analysisTypeFromTypeName(typeName: string) {
  const normalized = arrayTypeNameToArrayAlias(boxedCompletionTypeName(typeName)) ?? typeName;
  const shape = parseTypeNameShape(normalized);
  if (shape.arrayDepth > 0) {
    return arrayType(UNKNOWN_TYPE);
  }
  const baseName = shape.baseName;
  if (baseName === "int" || baseName === "number" || baseName === "string" || baseName === "boolean" || baseName === "bigint" || baseName === "long" || baseName === "void" || baseName === "unknown") {
    return builtinType(baseName);
  }
  return namedType(baseName);
}

interface CollectMemberDiagnosticsParams {
  uri: string;
  session: AnalysisSession;
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null | Promise<ClassResolverSessionLike | null>;
}

export async function collectCrossFileMemberDiagnostics(
  params: CollectMemberDiagnosticsParams
): Promise<Diagnostic[]> {
  const { session, sourceRoots, uri } = params;
  if (!session.ast || !session.analysis) {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const options = {
    uri,
    sourceRoots,
    ...(params.getSessionForFilePath
      ? { getSessionForFilePath: params.getSessionForFilePath }
      : {})
  };
  const resolverCache = createClassResolverCache();
  const currentFilePath = uriToFilePath(uri);

  for (const member of collectMemberExpressions(session.ast)) {
    if (member.computed || member.property.kind !== NodeKind.Identifier) {
      continue;
    }
    const objectTypeName = await resolveCrossFileExpressionTypeName(
      member.object,
      session.analysis,
      session.ast,
      options
    );
    if (!objectTypeName) {
      continue;
    }

    const resolvedObjectTypeName = arrayTypeNameToArrayAlias(boxedCompletionTypeName(objectTypeName)) ?? objectTypeName;
    const localEnum = findTopLevelDeclarationInProgram(
      session.ast,
      baseTypeName(resolvedObjectTypeName),
      (statement): statement is EnumStatement => statement.kind === NodeKind.EnumStatement
    );
    if (localEnum) {
      continue;
    }
    const classResolution = await resolveClassStatementAcrossFiles(
      session.ast,
      baseTypeName(resolvedObjectTypeName),
      options,
      resolverCache
    );
    if (!classResolution) {
      continue;
    }
    if (classResolution.filePath === "") {
      continue;
    }
    if (currentFilePath && classResolution.filePath === currentFilePath) {
      continue;
    }

    const memberName = (member.property as Identifier).name;
    const resolvedMember = await resolveClassMember(
      classResolution.classStatement,
      memberName,
      resolvedObjectTypeName,
      {
        ast: session.ast,
        options,
        cache: resolverCache
      }
    );
    if (resolvedMember) {
      continue;
    }
    const resolvedExtensionMember = await resolveExtensionMemberDeclarationAcrossFiles(
      {
        uri,
        line: firstTokenOrZero(member).line,
        character: firstTokenOrZero(member).character,
        session,
        sourceRoots,
        ...(params.getSessionForFilePath
          ? { getSessionForFilePath: params.getSessionForFilePath }
          : {})
      },
      analysisTypeFromTypeName(resolvedObjectTypeName),
      memberName
    );
    if (resolvedExtensionMember) {
      continue;
    }

    const firstToken = member.property.firstToken;
    const lastToken = member.property.lastToken;
    if (!firstToken || !lastToken) {
      continue;
    }

    const key = `${firstToken.range.start.line}:${firstToken.range.start.column}:${memberName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    diagnostics.push({
      code: VEXA_DIAGNOSTIC_CODES.MISSING_MEMBER,
      severity: DiagnosticSeverity.Error,
      range: {
        start: {
          line: firstToken.range.start.line,
          character: firstToken.range.start.column
        },
        end: {
          line: lastToken.range.end.line,
          character: lastToken.range.end.column
        }
      },
      message: `Property '${memberName}' does not exist on type '${objectTypeName}'`,
      source: "vexa-sema"
    });
  }

  return diagnostics;
}

function firstTokenOrZero(member: { firstToken?: { range: { start: { line: number; column: number } } } }): { line: number; character: number } {
  return {
    line: member.firstToken?.range.start.line ?? 0,
    character: member.firstToken?.range.start.column ?? 0
  };
}
