import { Analysis } from "compiler/analysis/Analysis";
import { Parser } from "compiler/parser/parser";
import { tokenize, type Token } from "compiler/parser/tokenizer";
import { ListReader } from "compiler/utils/ListReader";

export function buildAnalysisForSource(source: string): Analysis | null {
  try {
    const tokens = tokenize(source);
    const parser = new Parser(new ListReader<Token>(tokens));
    const ast = parser.parseFile();
    return new Analysis(ast);
  } catch {
    return null;
  }
}
