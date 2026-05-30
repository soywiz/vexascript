import { Analysis } from "compiler/analysis/Analysis";
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

export function transpile(source: string): TranspileResult {
  const withoutDeclarations = stripDeclareStatements(source);

  try {
    const tokens = tokenize(withoutDeclarations);
    const parser = new Parser(new ListReader(tokens));
    const ast = parser.parseFile();

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

  return {
    code: ensureTrailingSemicolon(withoutDeclarations),
    warnings: [],
    errors: []
  };
}
