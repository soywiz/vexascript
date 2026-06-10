import { baseTypeName } from "compiler/analysis/typeNames";
import type { Identifier, MemberExpression, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "./diagnosticSeverity";
import type { AnalysisSession } from "./analysisSession";
import {
  type ClassResolverSessionLike,
  createClassResolverCache,
  resolveClassMember,
  resolveClassStatementAcrossFiles,
  resolveExpressionTypeName as resolveCrossFileExpressionTypeName
} from "./classResolver";
import { VEXA_DIAGNOSTIC_CODES } from "./diagnosticCodes";

interface CollectMemberDiagnosticsParams {
  uri: string;
  session: AnalysisSession;
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null | Promise<ClassResolverSessionLike | null>;
}

function collectMemberExpressions(program: Program): MemberExpression[] {
  const expressions: MemberExpression[] = [];
  walkAst(program, (node) => {
    if (node.kind === "MemberExpression") {
      expressions.push(node as MemberExpression);
    }
  });
  return expressions;
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

  for (const member of collectMemberExpressions(session.ast)) {
    if (member.computed || member.property.kind !== "Identifier") {
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

    const classResolution = await resolveClassStatementAcrossFiles(
      session.ast,
      baseTypeName(objectTypeName),
      options,
      resolverCache
    );
    if (!classResolution) {
      continue;
    }

    const memberName = (member.property as Identifier).name;
    const resolvedMember = await resolveClassMember(
      classResolution.classStatement,
      memberName,
      objectTypeName,
      {
        ast: session.ast,
        options,
        cache: resolverCache
      }
    );
    if (resolvedMember) {
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
