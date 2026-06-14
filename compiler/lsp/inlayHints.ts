import type { Analysis } from "compiler/analysis/Analysis";
import type {
  ArrayLiteral,
  AsExpression,
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
  FunctionParameter,
  FunctionStatement,
  IfStatement,
  LabeledStatement,
  MemberExpression,
  NewExpression,
  NonNullExpression,
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
  WhileStatement,
  WithStatement
} from "compiler/ast/ast";
import type { InlayHint, Range } from "vscode-languageserver/node.js";
import {
  resolveCallableSignature,
  resolveConstructorSignature,
  resolveExpressionTypeName,
  type ClassResolverOptions
} from "./classResolver";

const InlayHintKind = {
  Type: 1,
  Parameter: 2
} as const;

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

export async function pickFunctionReturnTypeFromBody(
  body: Statement[],
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions
): Promise<string | null> {
  let resolved: string | null = null;
  let conflict = false;

  const consider = (typeName: string | null): void => {
    if (!typeName || typeName === "unknown") {
      return;
    }
    if (!resolved) {
      resolved = typeName;
      return;
    }
    if (resolved !== typeName) {
      conflict = true;
    }
  };

  const visitStatement = async (statement: Statement): Promise<void> => {
    switch (statement.kind) {
      case "ReturnStatement":
        consider(
          (statement as ReturnStatement).expression
            ? await resolveExpressionTypeName((statement as ReturnStatement).expression!, analysis, ast, options)
            : "undefined"
        );
        return;
      case "BlockStatement":
        for (const child of (statement as BlockStatement).body) {
          await visitStatement(child);
        }
        return;
      case "IfStatement":
        await visitStatement((statement as IfStatement).thenBranch);
        if ((statement as IfStatement).elseBranch) {
          await visitStatement((statement as IfStatement).elseBranch!);
        }
        return;
      case "WhileStatement":
      case "WithStatement":
      case "LabeledStatement":
      case "DoWhileStatement":
      case "ForStatement":
      case "SwitchStatement":
      case "TryStatement":
        return;
      case "FunctionStatement":
      case "ClassStatement":
        return;
      default:
        return;
    }
  };

  for (const statement of body) {
    await visitStatement(statement);
  }

  if (conflict) {
    return null;
  }
  return resolved;
}

interface FunctionLikeSignatureNode {
  name: {
    lastToken?: {
      range: {
        end: {
          line: number;
          column: number;
        };
      };
    };
  };
  parametersCloseParen?: {
    range: {
      end: {
        line: number;
        column: number;
      };
    };
  };
}

function getReturnTypeHintPosition(node: FunctionLikeSignatureNode): { line: number; character: number } | null {
  if (node.parametersCloseParen) {
    return {
      line: node.parametersCloseParen.range.end.line,
      character: node.parametersCloseParen.range.end.column
    };
  }
  if (!node.name.lastToken) {
    return null;
  }
  return {
    line: node.name.lastToken.range.end.line,
    character: node.name.lastToken.range.end.column
  };
}

async function pushParameterTypeHints(
  parameters: FunctionParameter[],
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions,
  range: Range,
  hints: InlayHint[]
): Promise<void> {
  for (const parameter of parameters) {
    if (parameter.typeAnnotation || !parameter.name.lastToken) {
      continue;
    }
    const inferred =
      parameter.defaultValue
        ? await resolveExpressionTypeName(parameter.defaultValue, analysis, ast, options)
        : null;
    if (!inferred || inferred === "unknown") {
      continue;
    }
    const position = {
      line: parameter.name.lastToken.range.end.line,
      character: parameter.name.lastToken.range.end.column
    };
    if (!inRange(position.line, position.character, range)) {
      continue;
    }
    hints.push({
      position,
      kind: InlayHintKind.Type,
      label: `: ${inferred}`
    });
  }
}

async function pushReturnTypeHint(
  node: FunctionLikeSignatureNode,
  explicitReturnType: { name: string } | undefined,
  body: Statement[],
  isAsync: boolean,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions,
  range: Range,
  hints: InlayHint[]
): Promise<void> {
  if (explicitReturnType) {
    return;
  }
  const inferred = await pickFunctionReturnTypeFromBody(body, analysis, ast, options);
  if (!inferred || inferred === "unknown") {
    return;
  }
  const position = getReturnTypeHintPosition(node);
  if (!position) {
    return;
  }
  if (!inRange(position.line, position.character, range)) {
    return;
  }
  const label = isAsync ? `Promise<${inferred}>` : inferred;
  hints.push({
    position,
    kind: InlayHintKind.Type,
    label: `: ${label}`
  });
}

async function pushTypeHintForVarStatement(
  statement: VarStatement,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions,
  range: Range,
  hints: InlayHint[]
): Promise<void> {
  if (statement.declarations && statement.declarations.length > 0) {
    for (const declaration of statement.declarations) {
      if (declaration.typeAnnotation || !declaration.initializer || !declaration.name.lastToken) {
        continue;
      }
      const inferredType = await resolveExpressionTypeName(declaration.initializer, analysis, ast, options);
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
  const inferredType = await resolveExpressionTypeName(statement.initializer, analysis, ast, options);
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

async function pushParameterHintsForCall(
  call: CallExpression,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions,
  range: Range,
  hints: InlayHint[]
): Promise<void> {
  const signature = await resolveCallableSignature(call.callee, analysis, ast, options);
  if (!signature) {
    return;
  }

  pushArgumentParameterHints(call.arguments, signature.parameters, range, hints);
}

async function pushParameterHintsForNewExpression(
  expression: NewExpression,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions,
  range: Range,
  hints: InlayHint[]
): Promise<void> {
  const signature = await resolveConstructorSignature(expression.callee, analysis, ast, options);
  if (!signature) {
    return;
  }

  pushArgumentParameterHints(expression.arguments ?? [], signature.parameters, range, hints);
}

/**
 * Pushes parameter-name inlay hints for a call/`new` argument list. Named
 * arguments (`key: value`) are skipped because the parameter name is already
 * written in the source; positional arguments are matched to parameters by
 * their running positional index, mirroring how named and positional arguments
 * are reordered during emission.
 */
function pushArgumentParameterHints(
  args: Expr[],
  parameters: { name: string }[],
  range: Range,
  hints: InlayHint[]
): void {
  let positionalIndex = 0;
  for (const argument of args) {
    if (argument.kind === "NamedArgument") {
      continue;
    }
    const parameter = parameters[positionalIndex];
    positionalIndex += 1;
    if (!argument.firstToken || !parameter) {
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

export interface InlayHintsEnabledOptions {
  parameters?: boolean;
  types?: boolean;
}

export async function createInlayHints(
  ast: Program,
  analysis: Analysis,
  range: Range,
  options: ClassResolverOptions = {},
  enabledOptions: InlayHintsEnabledOptions = {}
): Promise<InlayHint[]> {
  const hints: InlayHint[] = [];
  const showParameters = enabledOptions.parameters !== false;
  const showTypes = enabledOptions.types !== false;

  const visitExpression = async (expression: Expr): Promise<void> => {
    switch (expression.kind) {
      case "CallExpression": {
        const call = expression as CallExpression;
        await visitExpression(call.callee);
        for (const argument of call.arguments) {
          await visitExpression(argument);
        }
        if (showParameters) {
          await pushParameterHintsForCall(call, analysis, ast, options, range, hints);
        }
        return;
      }
      case "NewExpression":
        await visitExpression((expression as NewExpression).callee);
        for (const argument of (expression as NewExpression).arguments ?? []) {
          await visitExpression(argument);
        }
        if (showParameters) {
          await pushParameterHintsForNewExpression(
            expression as NewExpression,
            analysis,
            ast,
            options,
            range,
            hints
          );
        }
        return;
      case "MemberExpression":
        await visitExpression((expression as MemberExpression).object);
        if ((expression as MemberExpression).computed) {
          await visitExpression((expression as MemberExpression).property);
        }
        return;
      case "CommaExpression":
        for (const child of (expression as CommaExpression).expressions) {
          await visitExpression(child);
        }
        return;
      case "AsExpression":
        await visitExpression((expression as AsExpression).expression);
        return;
      case "NonNullExpression":
        await visitExpression((expression as NonNullExpression).expression);
        return;
      case "NamedArgument":
        await visitExpression((expression as unknown as { value: Expr }).value);
        return;
      case "BinaryExpression":
        await visitExpression((expression as BinaryExpression).left);
        await visitExpression((expression as BinaryExpression).right);
        return;
      case "RangeExpression":
        await visitExpression((expression as RangeExpression).start);
        await visitExpression((expression as RangeExpression).end);
        return;
      case "AssignmentExpression":
        await visitExpression((expression as AssignmentExpression).left);
        await visitExpression((expression as AssignmentExpression).right);
        return;
      case "ConditionalExpression":
        await visitExpression((expression as ConditionalExpression).test);
        await visitExpression((expression as ConditionalExpression).consequent);
        await visitExpression((expression as ConditionalExpression).alternate);
        return;
      case "UnaryExpression":
      case "UpdateExpression":
        await visitExpression((expression as UnaryExpression | UpdateExpression).argument);
        return;
      case "ArrayLiteral":
        for (const element of (expression as ArrayLiteral).elements) {
          await visitExpression(element);
        }
        return;
      case "ObjectLiteral":
        for (const property of (expression as ObjectLiteral).properties) {
          if (property.kind === "ObjectSpreadProperty") {
            await visitExpression(property.argument);
          } else {
            await visitExpression(property.value);
          }
        }
        return;
      default:
        return;
    }
  };

  const visitStatement = async (statement: Statement): Promise<void> => {
    switch (statement.kind) {
      case "VarStatement":
        if (showTypes) {
          await pushTypeHintForVarStatement(statement as VarStatement, analysis, ast, options, range, hints);
        }
        if ((statement as VarStatement).declarations && (statement as VarStatement).declarations!.length > 0) {
          for (const declaration of (statement as VarStatement).declarations!) {
            if (declaration.initializer) {
              await visitExpression(declaration.initializer);
            }
          }
        } else if ((statement as VarStatement).initializer) {
          await visitExpression((statement as VarStatement).initializer!);
        }
        return;
      case "ExprStatement":
        await visitExpression((statement as ExprStatement).expression);
        return;
      case "ReturnStatement":
        if ((statement as ReturnStatement).expression) {
          await visitExpression((statement as ReturnStatement).expression!);
        }
        return;
      case "ThrowStatement":
        await visitExpression((statement as ThrowStatement).expression);
        return;
      case "BlockStatement":
        for (const child of (statement as BlockStatement).body) {
          await visitStatement(child);
        }
        return;
      case "FunctionStatement":
        if (showTypes) {
          await pushParameterTypeHints(
            (statement as FunctionStatement).parameters,
            analysis,
            ast,
            options,
            range,
            hints
          );
          await pushReturnTypeHint(
            statement as FunctionStatement,
            (statement as FunctionStatement).returnType,
            (statement as FunctionStatement).body.body,
            (statement as FunctionStatement).async === true,
            analysis,
            ast,
            options,
            range,
            hints
          );
        }
        for (const child of (statement as FunctionStatement).body.body) {
          await visitStatement(child);
        }
        return;
      case "ClassStatement":
        for (const member of (statement as ClassStatement).members) {
          if (member.kind === "ClassFieldMember" && member.initializer) {
            await visitExpression(member.initializer);
          } else if (member.kind === "ClassMethodMember") {
            if (showTypes) {
              await pushParameterTypeHints(
                member.parameters,
                analysis,
                ast,
                options,
                range,
                hints
              );
              await pushReturnTypeHint(
                member,
                member.returnType,
                member.body.body,
                member.async === true,
                analysis,
                ast,
                options,
                range,
                hints
              );
            }
            for (const child of member.body.body) {
              await visitStatement(child);
            }
          }
        }
        return;
      case "IfStatement":
        await visitExpression((statement as IfStatement).condition);
        await visitStatement((statement as IfStatement).thenBranch);
        if ((statement as IfStatement).elseBranch) {
          await visitStatement((statement as IfStatement).elseBranch!);
        }
        return;
      case "WhileStatement":
        await visitExpression((statement as WhileStatement).condition);
        await visitStatement((statement as WhileStatement).body);
        return;
      case "WithStatement":
        await visitExpression((statement as WithStatement).object);
        await visitStatement((statement as WithStatement).body);
        return;
      case "LabeledStatement":
        await visitStatement((statement as LabeledStatement).body);
        return;
      case "DoWhileStatement":
        await visitStatement((statement as DoWhileStatement).body);
        await visitExpression((statement as DoWhileStatement).condition);
        return;
      case "ForStatement":
        if ((statement as ForStatement).initializer && (statement as ForStatement).initializer!.kind === "VarStatement") {
          await visitStatement((statement as ForStatement).initializer as Statement);
        } else if ((statement as ForStatement).initializer) {
          await visitExpression((statement as ForStatement).initializer as Expr);
        }
        if ((statement as ForStatement).iterator && (statement as ForStatement).iterator!.kind === "VarStatement") {
          await visitStatement((statement as ForStatement).iterator as Statement);
        } else if ((statement as ForStatement).iterator) {
          await visitExpression((statement as ForStatement).iterator as Expr);
        }
        if ((statement as ForStatement).iterable) {
          await visitExpression((statement as ForStatement).iterable!);
        }
        if ((statement as ForStatement).condition) {
          await visitExpression((statement as ForStatement).condition!);
        }
        if ((statement as ForStatement).update) {
          await visitExpression((statement as ForStatement).update!);
        }
        await visitStatement((statement as ForStatement).body);
        return;
      case "SwitchStatement":
        await visitExpression((statement as SwitchStatement).discriminant);
        for (const switchCase of (statement as SwitchStatement).cases) {
          if (switchCase.test) {
            await visitExpression(switchCase.test);
          }
          for (const child of switchCase.consequent) {
            await visitStatement(child);
          }
        }
        return;
      case "TryStatement":
        for (const child of (statement as TryStatement).tryBlock.body) {
          await visitStatement(child);
        }
        if ((statement as TryStatement).catchClause) {
          for (const child of (statement as TryStatement).catchClause!.body.body) {
            await visitStatement(child);
          }
        }
        if ((statement as TryStatement).finallyBlock) {
          for (const child of (statement as TryStatement).finallyBlock!.body) {
            await visitStatement(child);
          }
        }
        return;
      default:
        return;
    }
  };

  for (const statement of ast.body) {
    await visitStatement(statement);
  }

  return hints;
}
