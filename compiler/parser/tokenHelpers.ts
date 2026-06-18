/**
 * Pure token classification helpers. All functions are stateless and depend
 * only on the Token value passed to them — no parser instance state.
 */
import type { Token } from "./tokenizer";

/** Returns true when the token represents the end-of-file sentinel. */
export function isEofToken(token?: Token): boolean {
  return token?.type === "eof";
}

/**
 * Returns true when token `b` starts on a later line than token `a` ends,
 * indicating a physical line break between the two tokens.
 */
export function hasLineBreakBetween(a: Token | undefined, b: Token | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  return a.range.end.line < b.range.start.line;
}

/**
 * Converts a token to its type-annotation text representation. String
 * tokens are JSON-escaped; all other tokens use their raw value.
 */
export function typeTokenText(token: Token): string {
  if (token.type === "string") {
    return JSON.stringify(token.value);
  }
  return token.value;
}

/**
 * Returns true when the token value looks like it could begin a new
 * statement or declaration — used for error recovery heuristics.
 */
export function isLikelyStatementStart(token: Token | undefined): boolean {
  if (!token) {
    return false;
  }
  if (token.type === "symbol" && (token.value === "}" || token.value === "{")) {
    return true;
  }
  if (token.type !== "identifier") {
    return false;
  }
  return (
    token.value === "let" ||
    token.value === "var" ||
    token.value === "val" ||
    token.value === "const" ||
    token.value === "fun" ||
    token.value === "function" ||
    token.value === "enum" ||
    token.value === "declare" ||
    token.value === "export" ||
    token.value === "class" ||
    token.value === "if" ||
    token.value === "for" ||
    token.value === "while" ||
    token.value === "with" ||
    token.value === "do" ||
    token.value === "switch" ||
    token.value === "try" ||
    token.value === "catch" ||
    token.value === "finally" ||
    token.value === "defer" ||
    token.value === "return" ||
    token.value === "throw" ||
    token.value === "break" ||
    token.value === "continue" ||
    token.value === "debugger" ||
    token.value === "case" ||
    token.value === "default"
  );
}

/** Returns true when the string is a recognized class member modifier keyword. */
export function isClassMemberModifier(value: string): boolean {
  return (
    value === "override" ||
    value === "public" ||
    value === "private" ||
    value === "protected" ||
    value === "readonly" ||
    value === "static" ||
    value === "abstract" ||
    value === "async" ||
    value === "sync"
  );
}
