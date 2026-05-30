import { Analysis } from "compiler/analysis/Analysis";
import { Parser } from "compiler/parser/parser";
import { TokenizeError, tokenize } from "compiler/parser/tokenizer";
import { ListReader } from "compiler/utils/ListReader";
import { emitProgram } from "./emitter";

export interface TranspileResult {
  code: string;
  warnings: string[];
  errors: string[];
}

function ensureTrailingSemicolon(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return /[;{}]$/.test(trimmed) ? trimmed : `${trimmed};`;
}

export function transpile(source: string): TranspileResult {
  try {
    const tokens = tokenize(source);
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

    const emitted = emitProgram(ast, analysis.getExpressionTypes());
    return {
      code: ensureTrailingSemicolon(emitted),
      warnings: [],
      errors: []
    };
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
}
