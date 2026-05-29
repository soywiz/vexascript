import { parseExpression } from "../parser/parser";
import { tokenize as tokenizeSource, tokenizeReader, type Token } from "../parser/tokenizer";

export function tokenize(source: string): Token[] {
  return tokenizeSource(source);
}

export function toAstPreview(source: string) {
  return parseExpression(tokenizeReader(source));
}
