import type { Program } from "compiler/ast/ast";
import { Parser, type ParseIssue, type ParserOptions } from "compiler/parser/parser";
import { TokenizeError, tokenize } from "compiler/parser/tokenizer";
import { ListReader } from "compiler/utils/ListReader";

export interface ParseArtifacts {
  ast: Program | null;
  parserIssues: ParseIssue[];
  tokenizeError: TokenizeError | null;
  fatalError: string | null;
}

export function parseSource(source: string, options: ParserOptions = {}): ParseArtifacts {
  try {
    // MyLang always supports embedded XML; TypeScript opts in via `jsx`.
    const jsxEnabled = options.language !== "typescript" ? true : (options.jsx ?? false);
    const tokens = tokenize(source, { jsx: jsxEnabled });
    const parser = new Parser(new ListReader(tokens), options);
    const ast = parser.parseFile();
    return {
      ast,
      parserIssues: [...parser.errors],
      tokenizeError: null,
      fatalError: null
    };
  } catch (error) {
    if (error instanceof TokenizeError) {
      return {
        ast: null,
        parserIssues: [],
        tokenizeError: error,
        fatalError: null
      };
    }

    return {
      ast: null,
      parserIssues: [],
      tokenizeError: null,
      fatalError: error instanceof Error ? error.message : String(error)
    };
  }
}
