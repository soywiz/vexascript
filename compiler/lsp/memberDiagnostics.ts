import { CallExpression, EnumStatement, Identifier, MemberExpression } from "compiler/ast/ast";
import type { Expr } from "compiler/ast/ast";
import { baseTypeName } from "compiler/analysis/typeNames";
import {
  ArrayType,
  BuiltinType,
  NamedType,
  arrayType,
  builtinType,
  isUnknownType,
  namedType,
  UNKNOWN_TYPE
} from "compiler/analysis/types";

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

export interface CrossFileMemberDiagnosticWorkMetrics {
  collections: number;
  memberExpressionsVisited: number;
  analyzedMemberSkips: number;
  unsupportedReceiverSkips: number;
  unknownReceiverSkips: number;
  unsupportedReceiverChainSkips: number;
  objectTypeResolutions: number;
  unresolvedObjectTypeSkips: number;
  classResolutions: number;
  memberResolutions: number;
  extensionResolutions: number;
  diagnostics: number;
}

function emptyCrossFileMemberDiagnosticWorkMetrics(): CrossFileMemberDiagnosticWorkMetrics {
  return {
    collections: 0,
    memberExpressionsVisited: 0,
    analyzedMemberSkips: 0,
    unsupportedReceiverSkips: 0,
    unknownReceiverSkips: 0,
    unsupportedReceiverChainSkips: 0,
    objectTypeResolutions: 0,
    unresolvedObjectTypeSkips: 0,
    classResolutions: 0,
    memberResolutions: 0,
    extensionResolutions: 0,
    diagnostics: 0
  };
}

let workMetrics = emptyCrossFileMemberDiagnosticWorkMetrics();

export function getCrossFileMemberDiagnosticWorkMetrics(): Readonly<CrossFileMemberDiagnosticWorkMetrics> {
  return { ...workMetrics };
}

export function resetCrossFileMemberDiagnosticWorkMetrics(): void {
  workMetrics = emptyCrossFileMemberDiagnosticWorkMetrics();
}

function isCrossFileClassReceiverType(type: ReturnType<NonNullable<AnalysisSession["analysis"]>["getExpressionType"]>): boolean {
  return type instanceof NamedType || type instanceof ArrayType || type instanceof BuiltinType;
}

function receiverChainHasUnsupportedAnalyzedType(
  expression: Expr,
  analysis: NonNullable<AnalysisSession["analysis"]>
): boolean {
  let current: Expr | null = expression;
  while (current) {
    const type = analysis.getExpressionTypes().get(current);
    if (type && !isUnknownType(type) && !isCrossFileClassReceiverType(type)) {
      return true;
    }
    current = current instanceof MemberExpression
      ? current.object
      : current instanceof CallExpression
        ? current.callee
        : null;
  }
  return false;
}

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
  workMetrics.collections += 1;

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
    workMetrics.memberExpressionsVisited += 1;
    if (member.computed || !(member.property instanceof Identifier)) {
      continue;
    }
    const analyzedMemberType = session.analysis.getExpressionTypes().get(member);
    if (analyzedMemberType && !isUnknownType(analyzedMemberType)) {
      workMetrics.analyzedMemberSkips += 1;
      continue;
    }
    const analyzedReceiverType = session.analysis.getExpressionType(member.object);
    if (member.object instanceof Identifier && isUnknownType(analyzedReceiverType)) {
      workMetrics.unknownReceiverSkips += 1;
      continue;
    }
    if (
      analyzedReceiverType
      && !isUnknownType(analyzedReceiverType)
      && !isCrossFileClassReceiverType(analyzedReceiverType)
    ) {
      workMetrics.unsupportedReceiverSkips += 1;
      continue;
    }
    if (
      isUnknownType(analyzedReceiverType)
      && receiverChainHasUnsupportedAnalyzedType(member.object, session.analysis)
    ) {
      workMetrics.unsupportedReceiverChainSkips += 1;
      continue;
    }
    workMetrics.objectTypeResolutions += 1;
    const objectTypeName = await resolveCrossFileExpressionTypeName(
      member.object,
      session.analysis,
      session.ast,
      options
    );
    if (!objectTypeName || objectTypeName === "unknown") {
      workMetrics.unresolvedObjectTypeSkips += 1;
      continue;
    }

    const resolvedObjectTypeName = arrayTypeNameToArrayAlias(boxedCompletionTypeName(objectTypeName)) ?? objectTypeName;
    const localEnum = findTopLevelDeclarationInProgram(
      session.ast,
      baseTypeName(resolvedObjectTypeName),
      (statement): statement is EnumStatement => statement instanceof EnumStatement
    );
    if (localEnum) {
      continue;
    }
    workMetrics.classResolutions += 1;
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
    workMetrics.memberResolutions += 1;
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
    workMetrics.extensionResolutions += 1;
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
    workMetrics.diagnostics += 1;
  }

  return diagnostics;
}

function firstTokenOrZero(member: { firstToken?: { range: { start: { line: number; column: number } } } }): { line: number; character: number } {
  return {
    line: member.firstToken?.range.start.line ?? 0,
    character: member.firstToken?.range.start.column ?? 0
  };
}
