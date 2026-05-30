import { Analysis } from "compiler/analysis/Analysis";
import type { Program } from "compiler/ast/ast";
import { Parser, type ParseIssue } from "compiler/parser/parser";
import { TokenizeError, tokenize, type Token } from "compiler/parser/tokenizer";
import { ListReader } from "compiler/utils/ListReader";
import type { TextDocument } from "vscode-languageserver-textdocument";

export interface AnalysisSession {
  ast: Program | null;
  parserErrors: ParseIssue[];
  analysis: Analysis | null;
  tokenizeError: TokenizeError | null;
  fatalError: string | null;
}

export function createAnalysisSession(source: string): AnalysisSession {
  try {
    const tokens = tokenize(source);
    const parser = new Parser(new ListReader<Token>(tokens));
    const ast = parser.parseFile();

    try {
      return {
        ast,
        parserErrors: [...parser.errors],
        analysis: new Analysis(ast),
        tokenizeError: null,
        fatalError: null
      };
    } catch (error) {
      return {
        ast,
        parserErrors: [...parser.errors],
        analysis: null,
        tokenizeError: null,
        fatalError: error instanceof Error ? error.message : String(error)
      };
    }
  } catch (error) {
    if (error instanceof TokenizeError) {
      return {
        ast: null,
        parserErrors: [],
        analysis: null,
        tokenizeError: error,
        fatalError: null
      };
    }

    return {
      ast: null,
      parserErrors: [],
      analysis: null,
      tokenizeError: null,
      fatalError: error instanceof Error ? error.message : String(error)
    };
  }
}

export function buildAnalysisForSource(source: string): Analysis | null {
  return createAnalysisSession(source).analysis;
}

export class AnalysisSessionCache {
  private readonly cache = new Map<string, { version: number; session: AnalysisSession }>();

  getForDocument(document: TextDocument): AnalysisSession {
    const cached = this.cache.get(document.uri);
    if (cached && cached.version === document.version) {
      return cached.session;
    }

    const session = createAnalysisSession(document.getText());
    this.cache.set(document.uri, { version: document.version, session });
    return session;
  }

  delete(uri: string): void {
    this.cache.delete(uri);
  }

  clear(): void {
    this.cache.clear();
  }
}
