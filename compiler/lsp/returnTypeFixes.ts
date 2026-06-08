import type { Analysis } from "compiler/analysis/Analysis";
import type {
  ClassMethodMember,
  FunctionStatement,
  Program
} from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { type CodeAction } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import type { ClassResolverOptions } from "./classResolver";
import { pickFunctionReturnTypeFromBody } from "./inlayHints";
import { containsPosition, nodeRange, rangeSize, tokenRange, type Position } from "./ranges";

type FunctionLikeNode = FunctionStatement | ClassMethodMember;

interface ReturnTypeTarget {
  node: FunctionLikeNode;
}

/**
 * A function-like declaration is eligible for the "add explicit return type"
 * quick fix when it has a closing parameter parenthesis, no explicit return
 * type annotation, and is not a `set` accessor (setters never carry a return
 * type). The trigger region spans the signature header (from the function name
 * through the closing parenthesis) so the fix is offered while the cursor sits
 * "in the parentheses after the arguments".
 */
function findReturnTypeTargetAtPosition(ast: Program, position: Position): ReturnTypeTarget | null {
  const state: { best: { target: ReturnTypeTarget; size: number } | null } = {
    best: null
  };

  const consider = (node: FunctionLikeNode): void => {
    if (node.returnType) {
      return;
    }
    if (node.kind === "ClassMethodMember" && node.accessorKind === "set") {
      return;
    }
    if (!node.parametersCloseParen) {
      return;
    }

    const nameFirstToken = node.name.firstToken;
    const closeParen = node.parametersCloseParen;
    if (!nameFirstToken) {
      return;
    }

    const triggerRange = {
      start: {
        line: nameFirstToken.range.start.line,
        character: nameFirstToken.range.start.column
      },
      end: {
        line: closeParen.range.end.line,
        character: closeParen.range.end.column
      }
    };
    if (!containsPosition(triggerRange, position)) {
      return;
    }

    const functionRange = nodeRange(node);
    if (!functionRange) {
      return;
    }

    const size = rangeSize(functionRange);
    if (!state.best || size <= state.best.size) {
      state.best = { target: { node }, size };
    }
  };

  walkAst(ast, (node) => {
    if (node.kind === "FunctionStatement") {
      consider(node as FunctionStatement);
      return;
    }
    if (node.kind === "ClassMethodMember") {
      consider(node as ClassMethodMember);
    }
  });

  return state.best ? state.best.target : null;
}

export async function createReturnTypeCodeActions(params: {
  uri: string;
  ast: Program | null;
  analysis: Analysis | null;
  position: Position;
  options?: ClassResolverOptions;
}): Promise<CodeAction[]> {
  if (!params.ast || !params.analysis) {
    return [];
  }

  const target = findReturnTypeTargetAtPosition(params.ast, params.position);
  if (!target) {
    return [];
  }

  const inferred = await pickFunctionReturnTypeFromBody(
    target.node.body.body,
    params.analysis,
    params.ast,
    params.options ?? {}
  );
  if (!inferred || inferred === "unknown") {
    return [];
  }

  const returnType = target.node.async === true ? `Promise<${inferred}>` : inferred;

  const closeParenRange = tokenRange(target.node.parametersCloseParen);
  if (!closeParenRange) {
    return [];
  }

  return [
    {
      title: `Add explicit return type ': ${returnType}'`,
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [params.uri]: [
            {
              range: {
                start: closeParenRange.end,
                end: closeParenRange.end
              },
              newText: `: ${returnType}`
            }
          ]
        }
      }
    }
  ];
}
