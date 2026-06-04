import type {
  BlockStatement,
  ClassMethodMember,
  ClassStatement,
  Expr,
  DoWhileStatement,
  ForStatement,
  FunctionStatement,
  IfStatement,
  LabeledStatement,
  Program,
  ReturnStatement,
  SwitchStatement,
  Statement,
  TryStatement,
  WhileStatement,
  WithStatement
} from "compiler/ast/ast";
import { CodeActionKind, type CodeAction, type Range } from "vscode-languageserver/node.js";

interface Position {
  line: number;
  character: number;
}

interface NodeRange {
  start: Position;
  end: Position;
}

interface FunctionLikeTarget {
  node: FunctionStatement | ClassMethodMember;
  returnStatement: ReturnStatement;
  shorthand: boolean;
}

function comparePosition(a: Position, b: Position): number {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.character - b.character;
}

function containsPosition(range: NodeRange, position: Position): boolean {
  return comparePosition(position, range.start) >= 0 && comparePosition(position, range.end) <= 0;
}

function rangeSize(range: NodeRange): number {
  const lineSpan = range.end.line - range.start.line;
  if (lineSpan > 0) {
    return lineSpan * 100_000 + (range.end.character - range.start.character);
  }
  return range.end.character - range.start.character;
}

function nodeRange(node: {
  firstToken?: { range: { start: { line: number; column: number } } };
  lastToken?: { range: { end: { line: number; column: number } } };
}): NodeRange | null {
  if (!node.firstToken || !node.lastToken) {
    return null;
  }

  return {
    start: {
      line: node.firstToken.range.start.line,
      character: node.firstToken.range.start.column
    },
    end: {
      line: node.lastToken.range.end.line,
      character: node.lastToken.range.end.column
    }
  };
}

function tokenRange(token: {
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
} | undefined): NodeRange | null {
  if (!token) {
    return null;
  }

  return {
    start: {
      line: token.range.start.line,
      character: token.range.start.column
    },
    end: {
      line: token.range.end.line,
      character: token.range.end.column
    }
  };
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

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "FunctionStatement": {
        const fn = statement as FunctionStatement;
        consider(fn, fn.body);
        for (const child of fn.body.body) {
          visitStatement(child);
        }
        return;
      }
      case "ClassStatement": {
        const classStatement = statement as ClassStatement;
        for (const member of classStatement.members) {
          if (member.kind !== "ClassMethodMember") {
            continue;
          }
          consider(member, member.body);
          for (const child of member.body.body) {
            visitStatement(child);
          }
        }
        return;
      }
      case "BlockStatement":
        for (const child of (statement as BlockStatement).body) {
          visitStatement(child);
        }
        return;
      case "IfStatement": {
        const ifStatement = statement as IfStatement;
        visitStatement(ifStatement.thenBranch);
        if (ifStatement.elseBranch) {
          visitStatement(ifStatement.elseBranch);
        }
        return;
      }
      case "WhileStatement":
        visitStatement((statement as WhileStatement).body);
        return;
      case "WithStatement":
        visitStatement((statement as WithStatement).body);
        return;
      case "LabeledStatement":
        visitStatement((statement as LabeledStatement).body);
        return;
      case "DoWhileStatement":
        visitStatement((statement as DoWhileStatement).body);
        return;
      case "ForStatement":
        visitStatement((statement as ForStatement).body);
        return;
      case "SwitchStatement":
        for (const switchCase of (statement as SwitchStatement).cases) {
          for (const child of switchCase.consequent) {
            visitStatement(child);
          }
        }
        return;
      case "TryStatement": {
        const tryStatement = statement as TryStatement;
        for (const child of tryStatement.tryBlock.body) {
          visitStatement(child);
        }
        if (tryStatement.catchClause) {
          for (const child of tryStatement.catchClause.body.body) {
            visitStatement(child);
          }
        }
        if (tryStatement.finallyBlock) {
          for (const child of tryStatement.finallyBlock.body) {
            visitStatement(child);
          }
        }
        return;
      }
      default:
        return;
    }
  };

  for (const statement of ast.body) {
    visitStatement(statement);
  }

  return state.best ? state.best.target : null;
}

function shorthandRange(node: FunctionStatement | ClassMethodMember): Range | null {
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
