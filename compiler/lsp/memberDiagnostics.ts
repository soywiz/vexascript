import { baseTypeName } from "compiler/analysis/typeNames";
import type {
  ArrayLiteral,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  ClassStatement,
  ConditionalExpression,
  CommaExpression,
  DoWhileStatement,
  Expr,
  ExprStatement,
  ForStatement,
  FunctionStatement,
  Identifier,
  IfStatement,
  NewExpression,
  MemberExpression,
  ObjectLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
  Statement
  ,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement
} from "compiler/ast/ast";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "vscode-languageserver/node.js";
import type { AnalysisSession } from "./analysisSession";
import {
  type ClassResolverSessionLike,
  createClassResolverCache,
  resolveClassMember,
  resolveClassStatementAcrossFiles,
  resolveExpressionTypeName as resolveCrossFileExpressionTypeName
} from "./classResolver";
import { MYLANG_DIAGNOSTIC_CODES } from "./diagnosticCodes";

interface CollectMemberDiagnosticsParams {
  uri: string;
  session: AnalysisSession;
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null;
}

function collectMemberExpressions(program: Program): MemberExpression[] {
  const expressions: MemberExpression[] = [];

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "MemberExpression": {
        const member = expression as MemberExpression;
        expressions.push(member);
        visitExpression(member.object);
        if (member.computed) {
          visitExpression(member.property);
        }
        return;
      }
      case "CallExpression":
        visitExpression((expression as CallExpression).callee);
        for (const argument of (expression as CallExpression).arguments) {
          visitExpression(argument);
        }
        return;
      case "NewExpression":
        visitExpression((expression as NewExpression).callee);
        for (const argument of (expression as NewExpression).arguments ?? []) {
          visitExpression(argument);
        }
        return;
      case "CommaExpression":
        for (const child of (expression as CommaExpression).expressions) {
          visitExpression(child);
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
          if (property.kind === "ObjectSpreadProperty") {
            visitExpression(property.argument);
          } else {
            visitExpression(property.value);
          }
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

  return expressions;
}

export function collectCrossFileMemberDiagnostics(
  params: CollectMemberDiagnosticsParams
): Diagnostic[] {
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
    const objectTypeName = resolveCrossFileExpressionTypeName(
      member.object,
      session.analysis,
      session.ast,
      options
    );
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

    const memberName = (member.property as Identifier).name;
    const resolvedMember = resolveClassMember(
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
      code: MYLANG_DIAGNOSTIC_CODES.MISSING_MEMBER,
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
      source: "mylang-sema"
    });
  }

  return diagnostics;
}
