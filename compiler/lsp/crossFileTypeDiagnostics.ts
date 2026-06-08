import type {
  AssignmentExpression,
  CallExpression,
  Identifier,
  MemberExpression,
  NewExpression,
  Program
} from "compiler/ast/ast";
import { baseTypeName } from "compiler/analysis/typeNames";
import { walkAst } from "compiler/ast/traversal";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "vscode-languageserver/node.js";
import type { AnalysisSession } from "./analysisSession";
import { MYLANG_DIAGNOSTIC_CODES, type MyLangDiagnosticCode } from "./diagnosticCodes";
import {
  createClassResolverCache,
  resolveConstructorSignature,
  isTypeAssignableByName,
  resolveClassMember,
  resolveClassStatementAcrossFiles,
  resolveExpressionTypeName,
  type ClassResolverSessionLike
} from "./classResolver";

export interface CollectCrossFileTypeDiagnosticsParams {
  uri: string;
  session: AnalysisSession;
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null | Promise<ClassResolverSessionLike | null>;
}

function diagnosticForNode(
  node: { firstToken?: { range: { start: { line: number; column: number } } }; lastToken?: { range: { end: { line: number; column: number } } } },
  message: string,
  code: MyLangDiagnosticCode
): Diagnostic | null {
  if (!node.firstToken || !node.lastToken) {
    return null;
  }
  return {
    code,
    severity: DiagnosticSeverity.Error,
    range: {
      start: {
        line: node.firstToken.range.start.line,
        character: node.firstToken.range.start.column
      },
      end: {
        line: node.lastToken.range.end.line,
        character: node.lastToken.range.end.column
      }
    },
    message,
    source: "mylang-sema"
  };
}

function callDiagnosticNode(call: CallExpression) {
  return call.callee.kind === "MemberExpression" ? (call.callee as MemberExpression).property : call;
}

function constructorDiagnosticNode(node: CallExpression | NewExpression) {
  return node.callee.kind === "MemberExpression" ? (node.callee as MemberExpression).property : node.callee;
}

function collectCallExpressions(program: Program): CallExpression[] {
  const calls: CallExpression[] = [];
  walkAst(program, (node) => {
    if (node.kind === "CallExpression") {
      calls.push(node as CallExpression);
    }
  });
  return calls;
}

function collectAssignmentExpressions(program: Program): AssignmentExpression[] {
  const assignments: AssignmentExpression[] = [];
  walkAst(program, (node) => {
    if (node.kind === "AssignmentExpression") {
      assignments.push(node as AssignmentExpression);
    }
  });
  return assignments;
}

export async function collectCrossFileTypeDiagnostics(
  params: CollectCrossFileTypeDiagnosticsParams
): Promise<Diagnostic[]> {
  const { session } = params;
  if (!session.ast || !session.analysis) {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const existing = new Set(
    session.semanticIssues.map((issue) => {
      const token = issue.node.firstToken;
      if (!token) {
        return issue.message;
      }
      return `${token.range.start.line}:${token.range.start.column}:${issue.message}`;
    })
  );
  const options = {
    uri: params.uri,
    sourceRoots: params.sourceRoots,
    ...(params.getSessionForFilePath
      ? { getSessionForFilePath: params.getSessionForFilePath }
      : {})
  };
  const resolverCache = createClassResolverCache();

  const pushDiagnostic = (diagnostic: Diagnostic | null): void => {
    if (!diagnostic) {
      return;
    }
    const existingKey = `${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}`;
    if (existing.has(existingKey)) {
      return;
    }
    const key = `${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.range.end.line}:${diagnostic.range.end.character}:${diagnostic.message}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  for (const call of collectCallExpressions(session.ast)) {
    const constructorSignature = await resolveConstructorSignature(
      call.callee,
      session.analysis,
      session.ast,
      options
    );
    if (constructorSignature) {
      const providedCount = call.arguments.length;
      const requiredCount = constructorSignature.parameters.filter((parameter) => !parameter.optional).length;
      const totalCount = constructorSignature.parameters.length;

      if (providedCount < requiredCount) {
        pushDiagnostic(
          diagnosticForNode(
            constructorDiagnosticNode(call),
            `Expected at least ${requiredCount} argument(s), but got ${providedCount}`,
            MYLANG_DIAGNOSTIC_CODES.CALL_TOO_FEW_ARGUMENTS
          )
        );
      } else if (providedCount > totalCount) {
        pushDiagnostic(
          diagnosticForNode(
            constructorDiagnosticNode(call),
            `Expected at most ${totalCount} argument(s), but got ${providedCount}`,
            MYLANG_DIAGNOSTIC_CODES.CALL_TOO_MANY_ARGUMENTS
          )
        );
        for (let index = totalCount; index < providedCount; index += 1) {
          pushDiagnostic(
            diagnosticForNode(
              call.arguments[index] ?? constructorDiagnosticNode(call),
              `Unexpected argument ${index + 1}; function expects at most ${totalCount} argument(s)`,
              MYLANG_DIAGNOSTIC_CODES.CALL_UNEXPECTED_ARGUMENT
            )
          );
        }
      }
    }

    if (call.callee.kind !== "MemberExpression") {
      continue;
    }
    const callee = call.callee as MemberExpression;
    if (callee.computed || callee.property.kind !== "Identifier") {
      continue;
    }

    const objectTypeName = await resolveExpressionTypeName(callee.object, session.analysis, session.ast, options);
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

    const memberName = (callee.property as Identifier).name;
    const member = await resolveClassMember(classResolution.classStatement, memberName, objectTypeName, {
      ast: session.ast,
      options,
      cache: resolverCache
    });
    if (!member) {
      continue;
    }

    if (member.kind !== "method" || !member.signature) {
      pushDiagnostic(
        diagnosticForNode(
          callee.property,
          `Property '${memberName}' of type '${objectTypeName}' is not callable`,
          MYLANG_DIAGNOSTIC_CODES.TYPE_MISMATCH
        )
      );
      continue;
    }

    const signature = member.signature;
    const providedCount = call.arguments.length;
    const lastParameter = signature.parameters[signature.parameters.length - 1];
    const restParameter = lastParameter?.rest ? lastParameter : undefined;
    const fixedParameters = restParameter ? signature.parameters.slice(0, -1) : signature.parameters;
    const requiredCount = fixedParameters.filter((parameter) => !parameter.optional).length;
    const totalCount = fixedParameters.length;

    if (providedCount < requiredCount) {
      pushDiagnostic(
        diagnosticForNode(
          callDiagnosticNode(call),
          `Expected at least ${requiredCount} argument(s), but got ${providedCount}`,
          MYLANG_DIAGNOSTIC_CODES.CALL_TOO_FEW_ARGUMENTS
        )
      );
    } else if (!restParameter && providedCount > totalCount) {
      pushDiagnostic(
        diagnosticForNode(
          callDiagnosticNode(call),
          `Expected at most ${totalCount} argument(s), but got ${providedCount}`,
          MYLANG_DIAGNOSTIC_CODES.CALL_TOO_MANY_ARGUMENTS
        )
      );
      for (let index = totalCount; index < providedCount; index += 1) {
        pushDiagnostic(
          diagnosticForNode(
            call.arguments[index] ?? call,
            `Unexpected argument ${index + 1}; function expects at most ${totalCount} argument(s)`,
            MYLANG_DIAGNOSTIC_CODES.CALL_UNEXPECTED_ARGUMENT
          )
        );
      }
    }

    const comparableCount = restParameter ? providedCount : Math.min(providedCount, totalCount);
    for (let index = 0; index < comparableCount; index += 1) {
      const parameter = fixedParameters[index] ?? restParameter;
      const argument = call.arguments[index];
      if (!parameter || !argument) {
        continue;
      }
      const argumentTypeName = await resolveExpressionTypeName(argument, session.analysis, session.ast, options);
      if (!argumentTypeName || argumentTypeName === "unknown") {
        continue;
      }
      if (isTypeAssignableByName(argumentTypeName, parameter.typeName)) {
        continue;
      }
      pushDiagnostic(
        diagnosticForNode(
          argument,
          `Argument ${index + 1} of type '${argumentTypeName}' is not assignable to parameter '${parameter.name}' of type '${parameter.typeName}'`,
          MYLANG_DIAGNOSTIC_CODES.CALL_ARGUMENT_TYPE_MISMATCH
        )
      );
    }
  }

  for (const node of walkCallLikeNewExpressions(session.ast)) {
    const constructorSignature = await resolveConstructorSignature(
      node.callee,
      session.analysis,
      session.ast,
      options
    );
    if (!constructorSignature) {
      continue;
    }

    const providedCount = node.arguments?.length ?? 0;
    const requiredCount = constructorSignature.parameters.filter((parameter) => !parameter.optional).length;
    const totalCount = constructorSignature.parameters.length;

    if (providedCount < requiredCount) {
      pushDiagnostic(
        diagnosticForNode(
          constructorDiagnosticNode(node),
          `Expected at least ${requiredCount} argument(s), but got ${providedCount}`,
          MYLANG_DIAGNOSTIC_CODES.CALL_TOO_FEW_ARGUMENTS
        )
      );
    } else if (providedCount > totalCount) {
      pushDiagnostic(
        diagnosticForNode(
          constructorDiagnosticNode(node),
          `Expected at most ${totalCount} argument(s), but got ${providedCount}`,
          MYLANG_DIAGNOSTIC_CODES.CALL_TOO_MANY_ARGUMENTS
        )
      );
      for (let index = totalCount; index < providedCount; index += 1) {
        pushDiagnostic(
          diagnosticForNode(
            node.arguments?.[index] ?? constructorDiagnosticNode(node),
            `Unexpected argument ${index + 1}; function expects at most ${totalCount} argument(s)`,
            MYLANG_DIAGNOSTIC_CODES.CALL_UNEXPECTED_ARGUMENT
          )
        );
      }
    }
  }

  for (const assignment of collectAssignmentExpressions(session.ast)) {
    if (assignment.left.kind !== "MemberExpression") {
      continue;
    }
    const leftMember = assignment.left as MemberExpression;
    if (leftMember.computed || leftMember.property.kind !== "Identifier") {
      continue;
    }

    const objectTypeName = await resolveExpressionTypeName(leftMember.object, session.analysis, session.ast, options);
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

    const memberName = (leftMember.property as Identifier).name;
    const member = await resolveClassMember(classResolution.classStatement, memberName, objectTypeName, {
      ast: session.ast,
      options,
      cache: resolverCache
    });
    if (!member) {
      continue;
    }

    const leftTypeName = member.kind === "method"
      ? (member.signature
        ? `(${member.signature.parameters.map((parameter) => `${parameter.name}: ${parameter.typeName}`).join(", ")}) => ${member.signature.returnTypeName}`
        : member.typeName)
      : member.typeName;
    const rightTypeName = await resolveExpressionTypeName(assignment.right, session.analysis, session.ast, options);
    if (!rightTypeName || rightTypeName === "unknown" || leftTypeName === "unknown") {
      continue;
    }
    if (isTypeAssignableByName(rightTypeName, leftTypeName)) {
      continue;
    }

    pushDiagnostic(
      diagnosticForNode(
        assignment.right,
        `Type '${rightTypeName}' is not assignable to type '${leftTypeName}'`,
        MYLANG_DIAGNOSTIC_CODES.TYPE_MISMATCH
      )
    );
  }

  return diagnostics;
}

function walkCallLikeNewExpressions(program: Program): NewExpression[] {
  const nodes: NewExpression[] = [];
  walkAst(program, (node) => {
    if (node.kind === "NewExpression") {
      nodes.push(node as NewExpression);
    }
  });
  return nodes;
}
