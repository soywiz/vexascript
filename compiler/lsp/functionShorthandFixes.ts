import type {
  BlockStatement,
  ClassMethodMember,
  Expr,
  FunctionStatement,
  Program,
  ReturnStatement
} from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { CodeActionKind, type CodeAction, type Range } from "vscode-languageserver/node.js";
import { containsPosition, nodeRange, rangeSize, tokenRange, type Position } from "./ranges";

interface FunctionLikeTarget {
  node: FunctionStatement | ClassMethodMember;
  returnStatement: ReturnStatement;
  shorthand: boolean;
}

function isGetterShorthand(node: FunctionStatement | ClassMethodMember): node is ClassMethodMember {
  return node.kind === "ClassMethodMember" && node.accessorKind === "get" && node.getterShorthand === true;
}

function isRegularGetterAccessor(node: FunctionStatement | ClassMethodMember): node is ClassMethodMember {
  return node.kind === "ClassMethodMember" &&
    node.accessorKind === "get" &&
    node.parameters.length === 0 &&
    node.getterShorthand !== true;
}

function findFunctionLikeAtPosition(ast: Program, position: Position): FunctionLikeTarget | null {
  const state: {
    best: { target: FunctionLikeTarget; size: number } | null;
  } = {
    best: null
  };

  const consider = (
    node: FunctionStatement | ClassMethodMember,
    body: BlockStatement
  ): void => {
    if (body.body.length !== 1) {
      return;
    }

    const onlyStatement = body.body[0];
    if (!onlyStatement || onlyStatement.kind !== "ReturnStatement") {
      return;
    }

    const returnStatement = onlyStatement as ReturnStatement;
    if (!returnStatement.expression) {
      return;
    }

    const statementRange = nodeRange(returnStatement);
    const functionRange = nodeRange(node);
    const shorthand = body.firstToken?.type === "symbol" && body.firstToken.value === "=>";
    const triggerRange = shorthand ? tokenRange(body.firstToken) : statementRange;
    if (!triggerRange || !functionRange || !containsPosition(triggerRange, position)) {
      return;
    }

    const size = rangeSize(functionRange);
    if (!state.best || size <= state.best.size) {
      state.best = {
        target: {
          node,
          returnStatement,
          shorthand
        },
        size
      };
    }
  };

  walkAst(ast, (node) => {
    if (node.kind === "FunctionStatement") {
      const fn = node as FunctionStatement;
      consider(fn, fn.body);
      return;
    }
    if (node.kind === "ClassMethodMember") {
      const method = node as ClassMethodMember;
      consider(method, method.body);
    }
  });

  return state.best ? state.best.target : null;
}

function shorthandRange(node: FunctionStatement | ClassMethodMember): Range | null {
  if (isGetterShorthand(node)) {
    const nameLastToken = node.name.lastToken;
    const bodyLastToken = node.body.lastToken;
    if (!nameLastToken || !bodyLastToken) {
      return null;
    }

    return {
      start: {
        line: nameLastToken.range.end.line,
        character: nameLastToken.range.end.column
      },
      end: {
        line: bodyLastToken.range.end.line,
        character: bodyLastToken.range.end.column
      }
    };
  }

  const closeParen = node.parametersCloseParen;
  const body = node.body;
  if (!closeParen || !body.lastToken) {
    return null;
  }

  return {
    start: {
      line: closeParen.range.end.line,
      character: closeParen.range.end.column
    },
    end: {
      line: body.lastToken.range.end.line,
      character: body.lastToken.range.end.column
    }
  };
}

function fullBodyRange(node: FunctionStatement | ClassMethodMember): Range | null {
  if (isGetterShorthand(node)) {
    return shorthandRange(node);
  }

  const closeParen = node.parametersCloseParen;
  const body = node.body;
  const bodyFirstToken = body.firstToken;
  const bodyLastToken = body.lastToken;
  if (!closeParen || !bodyFirstToken || !bodyLastToken) {
    return null;
  }

  return {
    start: {
      line: closeParen.range.end.line,
      character: closeParen.range.end.column
    },
    end: {
      line: bodyLastToken.range.end.line,
      character: bodyLastToken.range.end.column
    }
  };
}

function expressionText(expression: Expr, text: string): string | null {
  const first = expression.firstToken;
  const last = expression.lastToken;
  if (!first || !last) {
    return null;
  }
  return text.slice(first.range.start.offset, last.range.end.offset);
}

function returnTypeText(node: FunctionStatement | ClassMethodMember, text: string): string {
  if (isGetterShorthand(node)) {
    const nameLastToken = node.name.lastToken;
    const bodyFirstToken = node.body.firstToken;
    if (!nameLastToken || !bodyFirstToken) {
      return "";
    }

    return text.slice(nameLastToken.range.end.offset, bodyFirstToken.range.start.offset).trimEnd();
  }

  const closeParen = node.parametersCloseParen;
  const bodyFirstToken = node.body.firstToken;
  if (!closeParen || !bodyFirstToken) {
    return "";
  }

  return text.slice(closeParen.range.end.offset, bodyFirstToken.range.start.offset).trimEnd();
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  let index = lineStart;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    index += 1;
  }
  return text.slice(lineStart, index);
}

function getterAccessorPrefixRange(node: ClassMethodMember): Range | null {
  const accessorToken = node.accessorToken;
  const bodyLastToken = node.body.lastToken;
  if (!accessorToken || !bodyLastToken) {
    return null;
  }

  return {
    start: {
      line: accessorToken.range.start.line,
      character: accessorToken.range.start.column
    },
    end: {
      line: bodyLastToken.range.end.line,
      character: bodyLastToken.range.end.column
    }
  };
}

function getterShorthandMemberRange(node: ClassMethodMember): Range | null {
  const nameFirstToken = node.name.firstToken;
  const bodyLastToken = node.body.lastToken;
  if (!nameFirstToken || !bodyLastToken) {
    return null;
  }

  return {
    start: {
      line: nameFirstToken.range.start.line,
      character: nameFirstToken.range.start.column
    },
    end: {
      line: bodyLastToken.range.end.line,
      character: bodyLastToken.range.end.column
    }
  };
}

function getterAccessorSuffixText(node: ClassMethodMember, text: string): string {
  const closeParen = node.parametersCloseParen;
  const bodyFirstToken = node.body.firstToken;
  if (!closeParen || !bodyFirstToken) {
    return "";
  }

  return text.slice(closeParen.range.end.offset, bodyFirstToken.range.start.offset).trimEnd();
}

export function createFunctionShorthandCodeActions(params: {
  uri: string;
  ast: Program | null;
  text: string;
  position: Position;
}): CodeAction[] {
  if (!params.ast) {
    return [];
  }

  const target = findFunctionLikeAtPosition(params.ast, params.position);
  if (!target) {
    return [];
  }

  const replacementText = expressionText(target.returnStatement.expression!, params.text);
  if (!replacementText) {
    return [];
  }

  if (target.shorthand) {
    if (isGetterShorthand(target.node)) {
      const replacementRange = getterShorthandMemberRange(target.node);
      if (!replacementRange) {
        return [];
      }

      const baseIndent = lineIndent(params.text, target.node.firstToken?.range.start.offset ?? 0);
      const bodyIndent = `${baseIndent}  `;
      return [
        {
          title: "Convert getter shorthand to full accessor",
          kind: CodeActionKind.QuickFix,
          edit: {
            changes: {
              [params.uri]: [
                {
                  range: replacementRange,
                  newText: `get ${target.node.name.name}()${returnTypeText(target.node, params.text)} {\n${bodyIndent}return ${replacementText}\n${baseIndent}}`
                }
              ]
            }
          }
        }
      ];
    }

    const replacementRange = fullBodyRange(target.node);
    if (!replacementRange) {
      return [];
    }

    const baseIndent = lineIndent(params.text, target.node.firstToken?.range.start.offset ?? 0);
    const bodyIndent = `${baseIndent}  `;
    return [
      {
        title: "Convert '=>' shorthand to full body",
        kind: CodeActionKind.QuickFix,
        edit: {
          changes: {
            [params.uri]: [
              {
                range: replacementRange,
                newText: `${returnTypeText(target.node, params.text)} {\n${bodyIndent}return ${replacementText}\n${baseIndent}}`
              }
            ]
          }
        }
      }
    ];
  }

  if (isRegularGetterAccessor(target.node)) {
    const replacementRange = getterAccessorPrefixRange(target.node);
    if (!replacementRange) {
      return [];
    }

    return [
      {
        title: "Convert full accessor to getter shorthand",
        kind: CodeActionKind.QuickFix,
        edit: {
          changes: {
            [params.uri]: [
              {
                range: replacementRange,
                newText: `${target.node.name.name}${getterAccessorSuffixText(target.node, params.text)} => ${replacementText}`
              }
            ]
          }
        }
      }
    ];
  }

  const replacementRange = shorthandRange(target.node);
  if (!replacementRange) {
    return [];
  }

  return [
    {
      title: "Convert single-return body to '=>' shorthand",
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [params.uri]: [
            {
              range: replacementRange,
              newText: ` => ${replacementText}`
            }
          ]
        }
      }
    }
  ];
}
