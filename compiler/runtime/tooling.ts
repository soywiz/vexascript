import { parseFile } from "../parser/parser";
import { tokenize as tokenizeSource, tokenizeReader, type Token } from "../parser/tokenizer";
import { formatSource } from "./formatter";

export function tokenize(source: string): Token[] {
  return tokenizeSource(source);
}

export function toAstPreview(source: string) {
  return parseFile(tokenizeReader(source));
}

export function format(source: string): string {
  return formatSource(source);
}
