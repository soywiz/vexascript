import type {
  ArrayLiteral,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  ClassStatement,
  ConditionalExpression,
  DoWhileStatement,
  Expr,
  ExprStatement,
  ForStatement,
  FunctionStatement,
  IfStatement,
  MemberExpression,
  NewExpression,
  ObjectLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
  Statement,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  Identifier,
  VarStatement,
  WhileStatement
} from "compiler/ast/ast";
import { baseTypeName } from "compiler/analysis/typeNames";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "vscode-languageserver/node.js";
import type { AnalysisSession } from "./analysisSession";
import { MYLANG_DIAGNOSTIC_CODES, type MyLangDiagnosticCode } from "./diagnosticCodes";
import {
  createClassResolverCache,
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
  getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null;
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

function collectCallExpressions(program: Program): CallExpression[] {
  const calls: CallExpression[] = [];

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "CallExpression": {
        const call = expression as CallExpression;
        calls.push(call);
        visitExpression(call.callee);
        for (const argument of call.arguments) {
          visitExpression(argument);
        }
        return;
      }
      case "MemberExpression":
        visitExpression((expression as MemberExpression).object);
        if ((expression as MemberExpression).computed) {
          visitExpression((expression as MemberExpression).property);
        }
        return;
      case "NewExpression":
        visitExpression((expression as NewExpression).callee);
        for (const argument of (expression as NewExpression).arguments ?? []) {
          visitExpression(argument);
        }
        return;
      case "BinaryExpression":
        visitExpression((expression as BinaryExpression).left);
        visitExpression((expression as BinaryExpression).right);
        return;
      case "RangeExpression":
        visitExpression((expression as RangeExpression).start);
        visitExpression((expression as RangeExpression).end);
        return;
      case "AssignmentExpression":
        visitExpression((expression as AssignmentExpression).left);
        visitExpression((expression as AssignmentExpression).right);
        return;
      case "ConditionalExpression":
        visitExpression((expression as ConditionalExpression).test);
        visitExpression((expression as ConditionalExpression).consequent);
        visitExpression((expression as ConditionalExpression).alternate);
        return;
      case "UnaryExpression":
      case "UpdateExpression":
        visitExpression((expression as UnaryExpression | UpdateExpression).argument);
        return;
      case "ArrayLiteral":
        for (const element of (expression as ArrayLiteral).elements) {
          visitExpression(element);
        }
        return;
      case "ObjectLiteral":
        for (const property of (expression as ObjectLiteral).properties) {
          visitExpression(property.value);
        }
        return;
      default:
        return;
    }
  };

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "VarStatement":
        if ((statement as VarStatement).declarations && (statement as VarStatement).declarations!.length > 0) {
          for (const declaration of (statement as VarStatement).declarations!) {
            if (declaration.initializer) {
              visitExpression(declaration.initializer);
            }
          }
        } else if ((statement as VarStatement).initializer) {
          visitExpression((statement as VarStatement).initializer!);
        }
        return;
      case "ExprStatement":
        visitExpression((statement as ExprStatement).expression);
        return;
      case "ReturnStatement":
        if ((statement as ReturnStatement).expression) {
          visitExpression((statement as ReturnStatement).expression!);
        }
        return;
      case "ThrowStatement":
        visitExpression((statement as ThrowStatement).expression);
        return;
      case "BlockStatement":
        for (const child of (statement as BlockStatement).body) {
          visitStatement(child);
        }
        return;
      case "FunctionStatement":
        for (const child of (statement as FunctionStatement).body.body) {
          visitStatement(child);
        }
        return;
      case "ClassStatement":
        for (const member of (statement as ClassStatement).members) {
          if (member.kind === "ClassFieldMember" && member.initializer) {
            visitExpression(member.initializer);
          } else if (member.kind === "ClassMethodMember") {
            for (const child of member.body.body) {
              visitStatement(child);
            }
          }
        }
        return;
      case "IfStatement":
        visitExpression((statement as IfStatement).condition);
        visitStatement((statement as IfStatement).thenBranch);
        if ((statement as IfStatement).elseBranch) {
          visitStatement((statement as IfStatement).elseBranch!);
        }
        return;
      case "WhileStatement":
        visitExpression((statement as WhileStatement).condition);
        visitStatement((statement as WhileStatement).body);
        return;
      case "DoWhileStatement":
        visitStatement((statement as DoWhileStatement).body);
        visitExpression((statement as DoWhileStatement).condition);
        return;
      case "ForStatement":
        if ((statement as ForStatement).initializer && (statement as ForStatement).initializer!.kind !== "VarStatement") {
          visitExpression((statement as ForStatement).initializer as Expr);
        } else if ((statement as ForStatement).initializer && (statement as ForStatement).initializer!.kind === "VarStatement") {
          visitStatement((statement as ForStatement).initializer as Statement);
        }
        if ((statement as ForStatement).iterator && (statement as ForStatement).iterator!.kind !== "VarStatement" && (statement as ForStatement).iterator!.kind !== "Identifier") {
          visitExpression((statement as ForStatement).iterator as Expr);
        }
        if ((statement as ForStatement).iterable) {
          visitExpression((statement as ForStatement).iterable!);
        }
        if ((statement as ForStatement).condition) {
          visitExpression((statement as ForStatement).condition!);
        }
        if ((statement as ForStatement).update) {
          visitExpression((statement as ForStatement).update!);
        }
        visitStatement((statement as ForStatement).body);
        return;
      case "SwitchStatement":
        visitExpression((statement as SwitchStatement).discriminant);
        for (const switchCase of (statement as SwitchStatement).cases) {
          if (switchCase.test) {
            visitExpression(switchCase.test);
          }
          for (const child of switchCase.consequent) {
            visitStatement(child);
          }
        }
        return;
      case "TryStatement":
        for (const child of (statement as TryStatement).tryBlock.body) {
          visitStatement(child);
        }
        if ((statement as TryStatement).catchClause) {
          for (const child of (statement as TryStatement).catchClause!.body.body) {
            visitStatement(child);
          }
        }
        if ((statement as TryStatement).finallyBlock) {
          for (const child of (statement as TryStatement).finallyBlock!.body) {
            visitStatement(child);
          }
        }
        return;
      default:
        return;
    }
  };

  for (const statement of program.body) {
    visitStatement(statement);
  }

  return calls;
}

function collectAssignmentExpressions(program: Program): AssignmentExpression[] {
  const assignments: AssignmentExpression[] = [];

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "AssignmentExpression": {
        const assignment = expression as AssignmentExpression;
        assignments.push(assignment);
        visitExpression(assignment.left);
        visitExpression(assignment.right);
        return;
      }
      case "CallExpression":
        visitExpression((expression as CallExpression).callee);
        for (const argument of (expression as CallExpression).arguments) {
          visitExpression(argument);
        }
        return;
      case "MemberExpression":
        visitExpression((expression as MemberExpression).object);
        if ((expression as MemberExpression).computed) {
          visitExpression((expression as MemberExpression).property);
        }
        return;
      case "NewExpression":
        visitExpression((expression as NewExpression).callee);
        for (const argument of (expression as NewExpression).arguments ?? []) {
          visitExpression(argument);
        }
        return;
      case "BinaryExpression":
        visitExpression((expression as BinaryExpression).left);
        visitExpression((expression as BinaryExpression).right);
        return;
      case "RangeExpression":
        visitExpression((expression as RangeExpression).start);
        visitExpression((expression as RangeExpression).end);
        return;
      case "ConditionalExpression":
        visitExpression((expression as ConditionalExpression).test);
        visitExpression((expression as ConditionalExpression).consequent);
        visitExpression((expression as ConditionalExpression).alternate);
        return;
      case "UnaryExpression":
      case "UpdateExpression":
        visitExpression((expression as UnaryExpression | UpdateExpression).argument);
        return;
      case "ArrayLiteral":
        for (const element of (expression as ArrayLiteral).elements) {
          visitExpression(element);
        }
        return;
      case "ObjectLiteral":
        for (const property of (expression as ObjectLiteral).properties) {
          visitExpression(property.value);
        }
        return;
      default:
        return;
    }
  };

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "VarStatement":
        if ((statement as VarStatement).declarations && (statement as VarStatement).declarations!.length > 0) {
          for (const declaration of (statement as VarStatement).declarations!) {
            if (declaration.initializer) {
              visitExpression(declaration.initializer);
            }
          }
        } else if ((statement as VarStatement).initializer) {
          visitExpression((statement as VarStatement).initializer!);
        }
        return;
      case "ExprStatement":
        visitExpression((statement as ExprStatement).expression);
        return;
      case "ReturnStatement":
        if ((statement as ReturnStatement).expression) {
          visitExpression((statement as ReturnStatement).expression!);
        }
        return;
      case "ThrowStatement":
        visitExpression((statement as ThrowStatement).expression);
        return;
      case "BlockStatement":
        for (const child of (statement as BlockStatement).body) {
          visitStatement(child);
        }
        return;
      case "FunctionStatement":
        for (const child of (statement as FunctionStatement).body.body) {
          visitStatement(child);
        }
        return;
      case "ClassStatement":
        for (const member of (statement as ClassStatement).members) {
          if (member.kind === "ClassFieldMember" && member.initializer) {
            visitExpression(member.initializer);
          } else if (member.kind === "ClassMethodMember") {
            for (const child of member.body.body) {
              visitStatement(child);
            }
          }
        }
        return;
      case "IfStatement":
        visitExpression((statement as IfStatement).condition);
        visitStatement((statement as IfStatement).thenBranch);
        if ((statement as IfStatement).elseBranch) {
          visitStatement((statement as IfStatement).elseBranch!);
        }
        return;
      case "WhileStatement":
        visitExpression((statement as WhileStatement).condition);
        visitStatement((statement as WhileStatement).body);
        return;
      case "DoWhileStatement":
        visitStatement((statement as DoWhileStatement).body);
        visitExpression((statement as DoWhileStatement).condition);
        return;
      case "ForStatement":
        if ((statement as ForStatement).initializer && (statement as ForStatement).initializer!.kind !== "VarStatement") {
          visitExpression((statement as ForStatement).initializer as Expr);
        } else if ((statement as ForStatement).initializer && (statement as ForStatement).initializer!.kind === "VarStatement") {
          visitStatement((statement as ForStatement).initializer as Statement);
        }
        if ((statement as ForStatement).iterator && (statement as ForStatement).iterator!.kind !== "VarStatement" && (statement as ForStatement).iterator!.kind !== "Identifier") {
          visitExpression((statement as ForStatement).iterator as Expr);
        }
        if ((statement as ForStatement).iterable) {
          visitExpression((statement as ForStatement).iterable!);
        }
        if ((statement as ForStatement).condition) {
          visitExpression((statement as ForStatement).condition!);
        }
        if ((statement as ForStatement).update) {
          visitExpression((statement as ForStatement).update!);
        }
        visitStatement((statement as ForStatement).body);
        return;
      case "SwitchStatement":
        visitExpression((statement as SwitchStatement).discriminant);
        for (const switchCase of (statement as SwitchStatement).cases) {
          if (switchCase.test) {
            visitExpression(switchCase.test);
          }
          for (const child of switchCase.consequent) {
            visitStatement(child);
          }
        }
        return;
      case "TryStatement":
        for (const child of (statement as TryStatement).tryBlock.body) {
          visitStatement(child);
        }
        if ((statement as TryStatement).catchClause) {
          for (const child of (statement as TryStatement).catchClause!.body.body) {
            visitStatement(child);
          }
        }
        if ((statement as TryStatement).finallyBlock) {
          for (const child of (statement as TryStatement).finallyBlock!.body) {
            visitStatement(child);
          }
        }
        return;
      default:
        return;
    }
  };

  for (const statement of program.body) {
    visitStatement(statement);
  }

  return assignments;
}

export function collectCrossFileTypeDiagnostics(
  params: CollectCrossFileTypeDiagnosticsParams
): Diagnostic[] {
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
    if (call.callee.kind !== "MemberExpression") {
      continue;
    }
    const callee = call.callee as MemberExpression;
    if (callee.computed || callee.property.kind !== "Identifier") {
      continue;
    }

    const objectTypeName = resolveExpressionTypeName(callee.object, session.analysis, session.ast, options);
    if (!objectTypeName) {
      continue;
    }

    const classResolution = resolveClassStatementAcrossFiles(
      session.ast,
      baseTypeName(objectTypeName),
      options,
      resolverCache
    );
    if (!classResolution) {
      continue;
    }

    const memberName = (callee.property as Identifier).name;
    const member = resolveClassMember(classResolution.classStatement, memberName, objectTypeName, {
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
    const requiredCount = signature.parameters.filter((parameter) => !parameter.optional).length;
    const totalCount = signature.parameters.length;

    if (providedCount < requiredCount) {
      pushDiagnostic(
        diagnosticForNode(
          call,
          `Expected at least ${requiredCount} argument(s), but got ${providedCount}`,
          MYLANG_DIAGNOSTIC_CODES.CALL_TOO_FEW_ARGUMENTS
        )
      );
    } else if (providedCount > totalCount) {
      pushDiagnostic(
        diagnosticForNode(
          call,
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

    const comparableCount = Math.min(providedCount, totalCount);
    for (let index = 0; index < comparableCount; index += 1) {
      const parameter = signature.parameters[index];
      const argument = call.arguments[index];
      if (!parameter || !argument) {
        continue;
      }
      const argumentTypeName = resolveExpressionTypeName(argument, session.analysis, session.ast, options);
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

  for (const assignment of collectAssignmentExpressions(session.ast)) {
    if (assignment.left.kind !== "MemberExpression") {
      continue;
    }
    const leftMember = assignment.left as MemberExpression;
    if (leftMember.computed || leftMember.property.kind !== "Identifier") {
      continue;
    }

    const objectTypeName = resolveExpressionTypeName(leftMember.object, session.analysis, session.ast, options);
    if (!objectTypeName) {
      continue;
    }

    const classResolution = resolveClassStatementAcrossFiles(
      session.ast,
      baseTypeName(objectTypeName),
      options,
      resolverCache
    );
    if (!classResolution) {
      continue;
    }

    const memberName = (leftMember.property as Identifier).name;
    const member = resolveClassMember(classResolution.classStatement, memberName, objectTypeName, {
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
    const rightTypeName = resolveExpressionTypeName(assignment.right, session.analysis, session.ast, options);
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
