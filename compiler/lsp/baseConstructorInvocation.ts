import { ArrowFunctionExpression, ClassExpression, ClassStatement, FunctionExpression } from "compiler/ast/ast";
import type { Expr, Identifier, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { comparePosition, containsPosition, nodeRange, rangeSize, tokenRange, type NodeRange, type Position } from "./ranges";

export interface BaseConstructorInvocationContext {
  callee: Identifier;
  arguments: Expr[];
  range: NodeRange;
  activeParameter: number;
}

function argumentIndexAtPosition(argumentsList: Expr[], position: Position): number {
  if (argumentsList.length === 0) return 0;
  let active = 0;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const range = nodeRange(argumentsList[index]!);
    if (range && comparePosition(position, range.start) < 0) return index;
    if (range && comparePosition(position, range.end) <= 0) return index;
    active = index + 1;
  }
  return active;
}

/** Finds the synthetic constructor invocation represented by `extends Base(...)`. */
export function findBaseConstructorInvocation(
  program: Program,
  position: Position,
  target: "arguments" | "callee"
): BaseConstructorInvocationContext | null {
  let best: BaseConstructorInvocationContext | null = null;
  let bestSize: number | null = null;

  walkAst(program, (node) => {
    if (!(node instanceof ClassStatement) && !(node instanceof ClassExpression)) return;
    if (!node.extendsType || node.extendsArguments === undefined) return;
    const calleeRange = nodeRange(node.extendsType);
    const closeRange = tokenRange(node.extendsArgumentsCloseParen);
    if (!calleeRange || !closeRange) return;
    const range = { start: calleeRange.start, end: closeRange.end };
    const matches = target === "callee"
      ? containsPosition(calleeRange, position)
      : containsPosition(range, position)
        && comparePosition(position, calleeRange.end) > 0
        && comparePosition(position, closeRange.end) < 0;
    if (!matches) return;

    if (target === "arguments") {
      for (const argument of node.extendsArguments) {
        if (!(argument instanceof ArrowFunctionExpression) && !(argument instanceof FunctionExpression)) continue;
        const bodyRange = nodeRange(argument.body);
        if (bodyRange && containsPosition(bodyRange, position)) return;
      }
    }

    const size = rangeSize(range);
    if (bestSize === null || size <= bestSize) {
      best = {
        callee: node.extendsType,
        arguments: node.extendsArguments,
        range,
        activeParameter: argumentIndexAtPosition(node.extendsArguments, position)
      };
      bestSize = size;
    }
  });

  return best;
}
