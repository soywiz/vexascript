import { ClassMethodMember, FunctionStatement } from "compiler/ast/ast";
import type { Program } from "compiler/ast/ast";
import type { Analysis } from "compiler/analysis/Analysis";

import { type CodeAction } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import type { ClassResolverOptions } from "./classResolver";
import { pickFunctionReturnTypeFromBody } from "./inlayHints";
import { findBestMatchAtPosition } from "./nodeSearch";
import { nodeRange, rangeSize, tokenRange, type Position } from "./ranges";

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
  return findBestMatchAtPosition(ast, position, (candidate) => {
    if (!(candidate instanceof FunctionStatement) && !(candidate instanceof ClassMethodMember)) {
      return null;
    }
    const node = candidate as FunctionLikeNode;
    if (node.returnType) {
      return null;
    }
    if (node instanceof ClassMethodMember && node.accessorKind === "set") {
      return null;
    }
    if (!node.parametersCloseParen) {
      return null;
    }

    const nameFirstToken = node.name.firstToken;
    const closeParen = node.parametersCloseParen;
    if (!nameFirstToken) {
      return null;
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
    const functionRange = nodeRange(node);
    if (!functionRange) {
      return null;
    }

    return {
      range: triggerRange,
      size: rangeSize(functionRange),
      build: () => ({ node })
    };
  });
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
