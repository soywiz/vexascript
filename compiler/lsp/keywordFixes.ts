import {
  BlockStatement,
  ClassStatement,
  DoWhileStatement,
  ForStatement,
  FunctionStatement,
  IfStatement,
  Program,
  Statement,
  SwitchStatement,
  VarStatement,
  WhileStatement
} from "compiler/ast/ast";

export interface KeywordReplacement {
  from: "let" | "const" | "var" | "val";
  to: "let" | "const" | "var" | "val";
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

const ALTERNATES: Record<KeywordReplacement["from"], KeywordReplacement["to"]> = {
  let: "const",
  const: "let",
  var: "val",
  val: "var"
};

function isPositionInsideTokenRange(
  token:
    | {
        range: {
          start: { line: number; column: number };
          end: { line: number; column: number };
        };
      }
    | undefined,
  line: number,
  character: number
): boolean {
  if (!token) {
    return false;
  }

  const start = token.range.start;
  const end = token.range.end;

  if (line < start.line || line > end.line) {
    return false;
  }
  if (line === start.line && character < start.column) {
    return false;
  }
  if (line === end.line && character > end.column) {
    return false;
  }

  return true;
}

function findVarStatementAtPosition(node: Statement, line: number, character: number): VarStatement | null {
  if (!isPositionInsideTokenRange(node.firstToken && node.lastToken ? { range: { start: node.firstToken.range.start, end: node.lastToken.range.end } } : undefined, line, character)) {
    return null;
  }

  if (node.kind === "VarStatement") {
    return node as VarStatement;
  }

  if (node.kind === "BlockStatement") {
    for (const child of (node as BlockStatement).body) {
      const match = findVarStatementAtPosition(child, line, character);
      if (match) {
        return match;
      }
    }
  }

  if (node.kind === "WhileStatement") {
    return findVarStatementAtPosition((node as WhileStatement).body, line, character);
  }

  if (node.kind === "DoWhileStatement") {
    return findVarStatementAtPosition((node as DoWhileStatement).body, line, character);
  }

  if (node.kind === "ForStatement") {
    const forStatement = node as ForStatement;
    if (forStatement.initializer && forStatement.initializer.kind === "VarStatement") {
      const initializerMatch = findVarStatementAtPosition(forStatement.initializer, line, character);
      if (initializerMatch) {
        return initializerMatch;
      }
    }
    return findVarStatementAtPosition(forStatement.body, line, character);
  }

  if (node.kind === "IfStatement") {
    const ifStatement = node as IfStatement;
    const thenMatch = findVarStatementAtPosition(ifStatement.thenBranch, line, character);
    if (thenMatch) {
      return thenMatch;
    }
    if (ifStatement.elseBranch) {
      return findVarStatementAtPosition(ifStatement.elseBranch, line, character);
    }
  }

  if (node.kind === "SwitchStatement") {
    const switchStatement = node as SwitchStatement;
    for (const switchCase of switchStatement.cases) {
      for (const consequentStatement of switchCase.consequent) {
        const match = findVarStatementAtPosition(consequentStatement, line, character);
        if (match) {
          return match;
        }
      }
    }
  }

  if (node.kind === "FunctionStatement") {
    return findVarStatementAtPosition((node as FunctionStatement).body, line, character);
  }

  if (node.kind === "ClassStatement") {
    for (const member of (node as ClassStatement).members) {
      if (member.kind === "ClassMethodMember") {
        const match = findVarStatementAtPosition(member.body, line, character);
        if (match) {
          return match;
        }
      }
    }
  }

  return null;
}

export function findDeclarationKeywordReplacementAtPosition(
  ast: Program,
  line: number,
  character: number
): KeywordReplacement | null {
  for (const statement of ast.body) {
    const variableStatement = findVarStatementAtPosition(statement, line, character);
    if (!variableStatement) {
      continue;
    }

    const declarationToken = variableStatement.firstToken;
    if (!declarationToken || declarationToken.type !== "identifier") {
      return null;
    }

    if (!isPositionInsideTokenRange(declarationToken, line, character)) {
      return null;
    }

    const from = declarationToken.value as KeywordReplacement["from"];
    const to = ALTERNATES[from];
    if (!to) {
      return null;
    }

    return {
      from,
      to,
      range: {
        start: { line: declarationToken.range.start.line, character: declarationToken.range.start.column },
        end: { line: declarationToken.range.end.line, character: declarationToken.range.end.column }
      }
    };
  }

  return null;
}
