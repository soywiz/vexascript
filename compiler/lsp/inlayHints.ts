import type { Analysis } from "compiler/analysis/Analysis";
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
  VarStatement,
  WhileStatement
} from "compiler/ast/ast";
import type { InlayHint, Range } from "vscode-languageserver/node.js";
import { InlayHintKind } from "vscode-languageserver/node.js";
import {
  resolveCallableSignature,
  resolveExpressionTypeName,
  type ClassResolverOptions
} from "./classResolver";

function inRange(
  line: number,
  character: number,
  range: Range
): boolean {
  if (line < range.start.line || line > range.end.line) {
    return false;
  }
  if (line === range.start.line && character < range.start.character) {
    return false;
  }
  if (line === range.end.line && character > range.end.character) {
    return false;
  }
  return true;
}

function pushTypeHintForVarStatement(
  statement: VarStatement,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions,
  range: Range,
  hints: InlayHint[]
): void {
  if (statement.declarations && statement.declarations.length > 0) {
    for (const declaration of statement.declarations) {
      if (declaration.typeAnnotation || !declaration.initializer || !declaration.name.lastToken) {
        continue;
      }
      const inferredType = resolveExpressionTypeName(declaration.initializer, analysis, ast, options);
      if (!inferredType || inferredType === "unknown") {
        continue;
      }
      const position = {
        line: declaration.name.lastToken.range.end.line,
        character: declaration.name.lastToken.range.end.column
      };
      if (!inRange(position.line, position.character, range)) {
        continue;
      }
      hints.push({
        position,
        kind: InlayHintKind.Type,
        label: `: ${inferredType}`
      });
    }
    return;
  }

  if (statement.typeAnnotation || !statement.initializer || !statement.name.lastToken) {
    return;
  }
  const inferredType = resolveExpressionTypeName(statement.initializer, analysis, ast, options);
  if (!inferredType || inferredType === "unknown") {
    return;
  }
  const position = {
    line: statement.name.lastToken.range.end.line,
    character: statement.name.lastToken.range.end.column
  };
  if (!inRange(position.line, position.character, range)) {
    return;
  }
  hints.push({
    position,
    kind: InlayHintKind.Type,
    label: `: ${inferredType}`
  });
}

function pushParameterHintsForCall(
  call: CallExpression,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions,
  range: Range,
  hints: InlayHint[]
): void {
  const signature = resolveCallableSignature(call.callee, analysis, ast, options);
  if (!signature) {
    return;
  }

  const comparableCount = Math.min(call.arguments.length, signature.parameters.length);
  for (let index = 0; index < comparableCount; index += 1) {
    const argument = call.arguments[index];
    const parameter = signature.parameters[index];
    if (!argument?.firstToken || !parameter) {
      continue;
    }
    const position = {
      line: argument.firstToken.range.start.line,
      character: argument.firstToken.range.start.column
    };
    if (!inRange(position.line, position.character, range)) {
      continue;
    }
    hints.push({
      position,
      kind: InlayHintKind.Parameter,
      label: `${parameter.name}: `
    });
  }
}

export function createInlayHints(
  ast: Program,
  analysis: Analysis,
  range: Range,
  options: ClassResolverOptions = {}
): InlayHint[] {
  const hints: InlayHint[] = [];

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "CallExpression": {
        const call = expression as CallExpression;
        visitExpression(call.callee);
        for (const argument of call.arguments) {
          visitExpression(argument);
        }
        pushParameterHintsForCall(call, analysis, ast, options, range, hints);
        return;
      }
      case "NewExpression":
        visitExpression((expression as NewExpression).callee);
        for (const argument of (expression as NewExpression).arguments ?? []) {
          visitExpression(argument);
        }
        return;
      case "MemberExpression":
        visitExpression((expression as MemberExpression).object);
        if ((expression as MemberExpression).computed) {
          visitExpression((expression as MemberExpression).property);
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
        pushTypeHintForVarStatement(statement as VarStatement, analysis, ast, options, range, hints);
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
        if ((statement as ForStatement).initializer && (statement as ForStatement).initializer!.kind === "VarStatement") {
          visitStatement((statement as ForStatement).initializer as Statement);
        } else if ((statement as ForStatement).initializer) {
          visitExpression((statement as ForStatement).initializer as Expr);
        }
        if ((statement as ForStatement).iterator && (statement as ForStatement).iterator!.kind === "VarStatement") {
          visitStatement((statement as ForStatement).iterator as Statement);
        } else if ((statement as ForStatement).iterator) {
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

  for (const statement of ast.body) {
    visitStatement(statement);
  }

  return hints;
}
