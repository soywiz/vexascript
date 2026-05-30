import { Analysis } from "compiler/analysis/Analysis";
import type { Expr, ForStatement, Program, Statement } from "compiler/ast/ast";
import { Parser } from "compiler/parser/parser";
import { TokenizeError, tokenize } from "compiler/parser/tokenizer";
import { ListReader } from "compiler/utils/ListReader";

export interface TranspileResult {
  code: string;
  warnings: string[];
  errors: string[];
}

function countOccurrences(text: string, ch: string): number {
  let count = 0;
  for (const current of text) {
    if (current === ch) {
      count += 1;
    }
  }
  return count;
}

function stripDeclareStatements(source: string): string {
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed.startsWith("declare ")) {
      kept.push(line);
      continue;
    }

    if (trimmed.startsWith("declare class ")) {
      let braceDepth = countOccurrences(line, "{") - countOccurrences(line, "}");
      while (braceDepth > 0 && i + 1 < lines.length) {
        i += 1;
        const nextLine = lines[i] ?? "";
        braceDepth += countOccurrences(nextLine, "{") - countOccurrences(nextLine, "}");
      }
      continue;
    }
  }

  return kept.join("\n");
}

function ensureTrailingSemicolon(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return /[;{}]$/.test(trimmed) ? trimmed : `${trimmed};`;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

function collectForStatements(program: Program): ForStatement[] {
  const collected: ForStatement[] = [];

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "ForStatement": {
        const forStatement = statement as ForStatement;
        collected.push(forStatement);
        visitStatement(forStatement.body);
        return;
      }
      case "BlockStatement":
        for (const child of statement.body) {
          visitStatement(child);
        }
        return;
      case "IfStatement":
        visitStatement(statement.thenBranch);
        if (statement.elseBranch) {
          visitStatement(statement.elseBranch);
        }
        return;
      case "WhileStatement":
      case "DoWhileStatement":
        visitStatement(statement.body);
        return;
      case "SwitchStatement":
        for (const switchCase of statement.cases) {
          for (const consequent of switchCase.consequent) {
            visitStatement(consequent);
          }
        }
        return;
      default:
        return;
    }
  };

  for (const statement of program.body) {
    visitStatement(statement);
  }
  return collected;
}

function findMatchingCloseParen(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function exprText(source: string, expr: Expr): string {
  if (!expr.firstToken || !expr.lastToken) {
    return "";
  }
  return source.slice(expr.firstToken.range.start.offset, expr.lastToken.range.end.offset);
}

function rewriteMylangForInLoops(source: string, program: Program): string {
  const replacements: Replacement[] = [];
  const forStatements = collectForStatements(program);

  for (const forStatement of forStatements) {
    if (forStatement.iterationKind !== "in" || !forStatement.iterator || !forStatement.iterable) {
      continue;
    }
    if (forStatement.iterator.kind !== "Identifier") {
      continue;
    }
    if (!forStatement.firstToken || forStatement.firstToken.value !== "for") {
      continue;
    }

    const forToken = forStatement.firstToken;
    const openParen = source.indexOf("(", forToken.range.end.offset);
    if (openParen < 0) {
      continue;
    }
    const closeParen = findMatchingCloseParen(source, openParen);
    if (closeParen < 0) {
      continue;
    }

    const iteratorText = exprText(source, forStatement.iterator);
    const iterableText = exprText(source, forStatement.iterable);
    replacements.push({
      start: openParen + 1,
      end: closeParen,
      text: `const ${iteratorText} of ${iterableText}`
    });
  }

  if (replacements.length === 0) {
    return source;
  }

  replacements.sort((a, b) => b.start - a.start);
  let output = source;
  for (const replacement of replacements) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  }
  return output;
}

export function transpile(source: string): TranspileResult {
  const withoutDeclarations = stripDeclareStatements(source);
  let ast: Program;

  try {
    const tokens = tokenize(withoutDeclarations);
    const parser = new Parser(new ListReader(tokens));
    ast = parser.parseFile();

    const errors: string[] = [];
    for (const issue of parser.errors) {
      if (issue.token) {
        errors.push(
          `${issue.message} at ${issue.token.range.start.line + 1}:${issue.token.range.start.column + 1}`
        );
      } else {
        errors.push(issue.message);
      }
    }
    if (errors.length > 0) {
      return { code: "", warnings: [], errors };
    }

    const analysis = new Analysis(ast);
    for (const issue of analysis.getIssues()) {
      const token = issue.node.firstToken;
      if (token) {
        errors.push(`${issue.message} at ${token.range.start.line + 1}:${token.range.start.column + 1}`);
      } else {
        errors.push(issue.message);
      }
    }
    if (errors.length > 0) {
      return { code: "", warnings: [], errors };
    }
  } catch (error) {
    if (error instanceof TokenizeError) {
      return {
        code: "",
        warnings: [],
        errors: [`${error.message} at ${error.range.start.line + 1}:${error.range.start.column + 1}`]
      };
    }
    return {
      code: "",
      warnings: [],
      errors: [error instanceof Error ? error.message : String(error)]
    };
  }

  const rewrittenSource = rewriteMylangForInLoops(withoutDeclarations, ast);
  return {
    code: ensureTrailingSemicolon(rewrittenSource),
    warnings: [],
    errors: []
  };
}
