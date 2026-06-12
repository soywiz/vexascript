/**
 * Call-argument completion strategy: argument-position detection, named
 * argument (`name:`) suggestions, and expected-type inference used to rank
 * in-scope symbols. Orchestrated by createCompletionItemsForPosition in
 * completion.ts.
 */
import { resolveCallableSignature, resolveConstructorSignature } from "./classResolver";
import { CompletionItemKind, classResolverOptionsFromCompletionOptions } from "./completionModel";
import type { CompletionRequestOptions } from "./completionModel";
import { comparePosition, containsPosition, nodeRange, rangeSize } from "./ranges";
import { Analysis } from "compiler/analysis/Analysis";
import type { ArrayLiteral, AsExpression, AssignmentExpression, BinaryExpression, BlockStatement, CallExpression, ClassMethodMember, ClassStatement, CommaExpression, ConditionalExpression, DoWhileStatement, Expr, ForStatement, FunctionStatement, IfStatement, LabeledStatement, MemberExpression, NewExpression, NonNullExpression, ObjectLiteral, Program, RangeExpression, ReturnStatement, Statement, SwitchStatement, ThrowStatement, TryStatement, UnaryExpression, UpdateExpression, VarStatement, WhileStatement, WithStatement } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import type { CompletionItem } from "vscode-languageserver/node.js";

export interface ArgumentCompletionContext {
  callee: Expr;
  argumentIndex: number;
  kind: "call" | "new";
}

export function findArgumentCompletionContext(
  ast: Program,
  line: number,
  character: number
): ArgumentCompletionContext | null {
  const position = { line, character };
  let bestContext: ArgumentCompletionContext | null = null;
  let bestSize: number | null = null;

  const considerCallLike = (
    kind: "call" | "new",
    callee: Expr,
    args: Expr[]
  ): void => {
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (!argument) {
        continue;
      }
      const argumentRange = nodeRange(argument);
      if (!argumentRange || !containsPosition(argumentRange, position)) {
        continue;
      }
      const size = rangeSize(argumentRange);
      if (bestSize === null || size <= bestSize) {
        bestContext = {
          callee,
          argumentIndex: index,
          kind
        };
        bestSize = size;
      }
    }
  };

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "CallExpression": {
        const call = expression as CallExpression;
        visitExpression(call.callee);
        for (const argument of call.arguments) {
          visitExpression(argument);
        }
        considerCallLike("call", call.callee, call.arguments);
        return;
      }
      case "NewExpression": {
        const call = expression as NewExpression;
        visitExpression(call.callee);
        for (const argument of call.arguments ?? []) {
          visitExpression(argument);
        }
        considerCallLike("new", call.callee, call.arguments ?? []);
        return;
      }
      case "MemberExpression":
        visitExpression((expression as MemberExpression).object);
        if ((expression as MemberExpression).computed) {
          visitExpression((expression as MemberExpression).property);
        }
        return;
      case "CommaExpression":
        for (const child of (expression as CommaExpression).expressions) {
          visitExpression(child);
        }
        return;
      case "AsExpression":
        visitExpression((expression as AsExpression).expression);
        return;
      case "NonNullExpression":
        visitExpression((expression as NonNullExpression).expression);
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
      case "VarStatement": {
        const variable = statement as VarStatement;
        if (variable.declarations?.length) {
          for (const declaration of variable.declarations) {
            if (declaration.initializer) {
              visitExpression(declaration.initializer);
            }
          }
        } else if (variable.initializer) {
          visitExpression(variable.initializer);
        }
        return;
      }
      case "ExprStatement":
        visitExpression((statement as { kind: "ExprStatement"; expression: Expr }).expression);
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
            for (const child of (member as ClassMethodMember).body.body) {
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
      case "WithStatement":
        visitExpression((statement as WithStatement).object);
        visitStatement((statement as WithStatement).body);
        return;
      case "LabeledStatement":
        visitStatement((statement as LabeledStatement).body);
        return;
      case "DoWhileStatement":
        visitStatement((statement as DoWhileStatement).body);
        visitExpression((statement as DoWhileStatement).condition);
        return;
      case "ForStatement": {
        const loop = statement as ForStatement;
        if (loop.initializer?.kind === "VarStatement") {
          visitStatement(loop.initializer as Statement);
        } else if (loop.initializer) {
          visitExpression(loop.initializer as Expr);
        }
        if (loop.iterator?.kind === "VarStatement") {
          visitStatement(loop.iterator as Statement);
        } else if (loop.iterator?.kind !== "Identifier" && loop.iterator) {
          visitExpression(loop.iterator as Expr);
        }
        if (loop.iterable) {
          visitExpression(loop.iterable);
        }
        if (loop.condition) {
          visitExpression(loop.condition);
        }
        if (loop.update) {
          visitExpression(loop.update);
        }
        visitStatement(loop.body);
        return;
      }
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

  return bestContext;
}

export interface NamedArgumentCallContext {
  callee: Expr;
  isNew: boolean;
}

/**
 * Finds the innermost call or `new` expression whose argument list encloses the
 * cursor, so named-argument completions can offer the callee's parameter names.
 * Unlike {@link findArgumentCompletionContext}, it does not require an existing
 * argument at the cursor, so it also works for empty (`fetch(|)`) and partially
 * typed (`fetch(ur|)`) argument lists. The cursor must sit past the callee so we
 * are inside the parentheses rather than on the callee itself.
 */
export function findNamedArgumentCallContext(
  ast: Program,
  line: number,
  character: number
): NamedArgumentCallContext | null {
  const position = { line, character };
  let best: NamedArgumentCallContext | null = null;
  let bestSize: number | null = null;

  walkAst(ast, (node) => {
    if (node.kind !== "CallExpression" && node.kind !== "NewExpression") {
      return;
    }
    const callLike = node as CallExpression | NewExpression;
    const range = nodeRange(callLike);
    if (!range || !containsPosition(range, position)) {
      return;
    }
    const calleeRange = nodeRange(callLike.callee);
    if (calleeRange && comparePosition(position, calleeRange.end) <= 0) {
      return;
    }
    const size = rangeSize(range);
    if (bestSize === null || size <= bestSize) {
      best = { callee: callLike.callee, isNew: node.kind === "NewExpression" };
      bestSize = size;
    }
  });

  return best;
}

export async function buildNamedArgumentCompletionItems(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions
): Promise<CompletionItem[]> {
  const context = findNamedArgumentCallContext(ast, line, character);
  if (!context) {
    return [];
  }
  const resolverOptions = classResolverOptionsFromCompletionOptions(options);
  const signature = context.isNew
    ? await resolveConstructorSignature(context.callee, analysis, ast, resolverOptions)
    : await resolveCallableSignature(context.callee, analysis, ast, resolverOptions);
  const parameters = signature?.parameters ?? [];
  const items: CompletionItem[] = [];
  for (const parameter of parameters) {
    if (parameter.rest) {
      continue;
    }
    items.push({
      label: `${parameter.name}:`,
      kind: CompletionItemKind.Field,
      detail: `Named argument: ${parameter.typeName}`,
      filterText: parameter.name,
      insertText: `${parameter.name}: `,
      sortText: `0-${parameter.name}`
    });
  }
  return items;
}

export async function inferExpectedTypeForPosition(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions
): Promise<string | null> {
  const context = findArgumentCompletionContext(ast, line, character);
  if (!context) {
    return null;
  }

  if (context.kind === "call") {
    const signature = await resolveCallableSignature(
      context.callee,
      analysis,
      ast,
      classResolverOptionsFromCompletionOptions(options)
    );
    return signature?.parameters[context.argumentIndex]?.typeName ?? null;
  }

  const constructorSignature = await resolveConstructorSignature(
    context.callee,
    analysis,
    ast,
    classResolverOptionsFromCompletionOptions(options)
  );
  return constructorSignature?.parameters[context.argumentIndex]?.typeName ?? null;
}
