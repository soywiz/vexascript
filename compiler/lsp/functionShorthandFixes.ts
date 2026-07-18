import { NodeKind } from "compiler/ast/ast";
import type {
  BlockStatement,
  ClassMethodMember,
  Expr,
  FunctionStatement,
  Program,
  ReturnStatement
} from "compiler/ast/ast";
import { type CodeAction, type Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { findBestMatchAtPosition } from "./nodeSearch";
import { nodeRange, rangeSize, tokenEndPosition, tokenRange, tokenStartPosition, type Position } from "./ranges";

interface FunctionLikeTarget {
  node: FunctionStatement | ClassMethodMember;
  returnStatement: ReturnStatement;
  shorthand: boolean;
}

function isGetterShorthand(node: FunctionStatement | ClassMethodMember): node is ClassMethodMember {
  return node.kind === NodeKind.ClassMethodMember && node.accessorKind === "get" && node.getterShorthand === true;
}

function isRegularGetterAccessor(node: FunctionStatement | ClassMethodMember): node is ClassMethodMember {
  return node.kind === NodeKind.ClassMethodMember &&
    node.accessorKind === "get" &&
    node.parameters.length === 0 &&
    node.getterShorthand !== true;
}

function findFunctionLikeAtPosition(ast: Program, position: Position): FunctionLikeTarget | null {
  return findBestMatchAtPosition(ast, position, (candidate) => {
    if (candidate.kind !== NodeKind.FunctionStatement && candidate.kind !== NodeKind.ClassMethodMember) {
      return null;
    }
    const node = candidate as FunctionStatement | ClassMethodMember;
    const body: BlockStatement = node.body;
    if (body.body.length !== 1) {
      return null;
    }

    const onlyStatement = body.body[0];
    if (!onlyStatement || onlyStatement.kind !== NodeKind.ReturnStatement) {
      return null;
    }

    const returnStatement = onlyStatement as ReturnStatement;
    if (!returnStatement.expression) {
      return null;
    }

    const statementRange = nodeRange(returnStatement);
    const functionRange = nodeRange(node);
    const shorthand = body.firstToken?.type === "symbol" && body.firstToken.value === "=>";
    const triggerRange = shorthand ? tokenRange(body.firstToken) : statementRange;
    if (!triggerRange || !functionRange) {
      return null;
    }

    return {
      range: triggerRange,
      size: rangeSize(functionRange),
      build: () => ({ node, returnStatement, shorthand })
    };
  });
}

function shorthandRange(node: FunctionStatement | ClassMethodMember): Range | null {
  if (isGetterShorthand(node)) {
    const nameLastToken = node.name.lastToken;
    const bodyLastToken = node.body.lastToken;
    if (!nameLastToken || !bodyLastToken) {
      return null;
    }

    return {
      start: tokenEndPosition(nameLastToken),
      end: tokenEndPosition(bodyLastToken)
    };
  }

  const closeParen = node.parametersCloseParen;
  const body = node.body;
  if (!closeParen || !body.lastToken) {
    return null;
  }

  return {
    start: tokenEndPosition(closeParen),
    end: tokenEndPosition(body.lastToken)
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
    start: tokenEndPosition(closeParen),
    end: tokenEndPosition(bodyLastToken)
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
    start: tokenStartPosition(accessorToken),
    end: tokenEndPosition(bodyLastToken)
  };
}

function getterShorthandMemberRange(node: ClassMethodMember): Range | null {
  const nameFirstToken = node.name.firstToken;
  const bodyLastToken = node.body.lastToken;
  if (!nameFirstToken || !bodyLastToken) {
    return null;
  }

  return {
    start: tokenStartPosition(nameFirstToken),
    end: tokenEndPosition(bodyLastToken)
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
