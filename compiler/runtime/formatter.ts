interface FormatToken {
  type: "identifier" | "number" | "string" | "commentLine" | "commentBlock" | "symbol" | "newline";
  value: string;
}

const INDENT = "  ";

const MULTI_CHAR_SYMBOLS = [
  ">>>=",
  "===",
  "!==",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "++",
  "--",
  "**",
  "<=",
  ">=",
  "==",
  "!=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "&&",
  "||",
  "<<",
  ">>",
  "?.",
  "!."
] as const;

const UNARY_PREFIX_OPERATORS = new Set(["+", "-", "++", "--", "!", "~"]);
const BINARY_OPERATORS = new Set([
  "+", "-", "*", "/", "%", "**",
  "<<", ">>", ">>>",
  "<", ">", "<=", ">=",
  "==", "!=", "===", "!==",
  "&", "|", "^", "&&", "||",
  "=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", ">>>=", "&=", "|=", "&&=", "||="
]);

const CONTROL_KEYWORDS_WITH_PAREN = new Set(["if", "for", "while", "switch", "catch"]);

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string): boolean {
  return /[0-9]/.test(ch);
}

function tokenizeForFormatting(source: string): FormatToken[] {
  const tokens: FormatToken[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (ch === "\r") {
      i += 1;
      continue;
    }

    if (ch === "\n") {
      tokens.push({ type: "newline", value: "\n" });
      i += 1;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\v" || ch === "\f") {
      i += 1;
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      const start = i;
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      tokens.push({ type: "commentLine", value: source.slice(start, i) });
      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        i += 1;
      }
      if (i < source.length) {
        i += 2;
      }
      tokens.push({ type: "commentBlock", value: source.slice(start, i) });
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ type: "string", value: source.slice(start, i) });
      continue;
    }

    if (isIdentifierStart(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && isIdentifierPart(source[i])) {
        i += 1;
      }
      tokens.push({ type: "identifier", value: source.slice(start, i) });
      continue;
    }

    if (isDigit(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && /[0-9A-Za-z_.]/.test(source[i])) {
        i += 1;
      }
      tokens.push({ type: "number", value: source.slice(start, i) });
      continue;
    }

    let matched = "";
    for (const symbol of MULTI_CHAR_SYMBOLS) {
      if (source.startsWith(symbol, i)) {
        matched = symbol;
        break;
      }
    }

    if (matched.length > 0) {
      tokens.push({ type: "symbol", value: matched });
      i += matched.length;
      continue;
    }

    tokens.push({ type: "symbol", value: ch });
    i += 1;
  }

  return tokens;
}

function isWordLike(token: FormatToken | undefined): boolean {
  if (!token) {
    return false;
  }
  return token.type === "identifier" || token.type === "number" || token.type === "string";
}

function isMemberOperator(token: FormatToken | undefined): boolean {
  return token?.type === "symbol" && (token.value === "." || token.value === "?." || token.value === "!.");
}

function isUnaryPrefix(current: FormatToken, previousSignificant: FormatToken | undefined): boolean {
  if (current.type !== "symbol" || !UNARY_PREFIX_OPERATORS.has(current.value)) {
    return false;
  }

  if (!previousSignificant) {
    return true;
  }

  if (previousSignificant.type === "symbol") {
    const v = previousSignificant.value;
    if (
      v === "(" || v === "[" || v === "{" || v === "," || v === ";" || v === ":" ||
      BINARY_OPERATORS.has(v)
    ) {
      return true;
    }
  }

  if (previousSignificant.type === "identifier") {
    const keyword = previousSignificant.value;
    if (keyword === "return" || keyword === "case" || keyword === "default" || keyword === "throw") {
      return true;
    }
  }

  return false;
}

function isBinaryOperatorToken(current: FormatToken, previousSignificant: FormatToken | undefined): boolean {
  if (current.type !== "symbol" || !BINARY_OPERATORS.has(current.value)) {
    return false;
  }
  return !isUnaryPrefix(current, previousSignificant);
}

function shouldSpaceBefore(
  previous: FormatToken | undefined,
  current: FormatToken,
  previousSignificant: FormatToken | undefined
): boolean {
  if (!previous) {
    return false;
  }

  if (isMemberOperator(previous) || isMemberOperator(current)) {
    return false;
  }

  if (current.type === "symbol" && (current.value === ")" || current.value === "]" || current.value === "}" || current.value === "," || current.value === ";")) {
    return false;
  }

  if (previous.type === "symbol" && (previous.value === "(" || previous.value === "[" || previous.value === "{")) {
    return false;
  }

  if (current.type === "symbol" && current.value === ":") {
    return false;
  }

  if (current.type === "symbol" && current.value === "{") {
    return !!previousSignificant && !(previousSignificant.type === "symbol" && previousSignificant.value === "{");
  }

  if (previous.type === "symbol" && (previous.value === "," || previous.value === ":")) {
    return true;
  }

  if (current.type === "symbol" && current.value === "(") {
    return !!(previous.type === "identifier" && CONTROL_KEYWORDS_WITH_PAREN.has(previous.value));
  }

  if (isBinaryOperatorToken(current, previousSignificant)) {
    return true;
  }

  if (previous.type === "symbol" && isBinaryOperatorToken(previous, undefined)) {
    return true;
  }

  if (previous.type === "symbol" && isUnaryPrefix(previous, previousSignificant)) {
    return false;
  }

  if (isWordLike(previous) && isWordLike(current)) {
    return true;
  }

  return false;
}

export function formatSource(source: string): string {
  const tokens = tokenizeForFormatting(source);

  let result = "";
  let indentLevel = 0;
  let atLineStart = true;
  let parenDepth = 0;
  let bracketDepth = 0;

  let previousEmitted: FormatToken | undefined;
  let previousSignificant: FormatToken | undefined;

  const writeIndentIfNeeded = (): void => {
    if (atLineStart) {
      result += INDENT.repeat(Math.max(indentLevel, 0));
      atLineStart = false;
    }
  };

  const writeNewline = (): void => {
    result = result.replace(/[ \t]+$/g, "");
    if (!result.endsWith("\n")) {
      result += "\n";
    }
    atLineStart = true;
    previousEmitted = undefined;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.type === "newline") {
      if (parenDepth === 0 && bracketDepth === 0 && !atLineStart) {
        writeNewline();
      }
      continue;
    }

    if (token.type === "commentLine") {
      writeIndentIfNeeded();
      if (previousEmitted && shouldSpaceBefore(previousEmitted, token, previousSignificant)) {
        result += " ";
      }
      result += token.value;
      previousEmitted = token;
      previousSignificant = token;
      writeNewline();
      continue;
    }

    if (token.type === "commentBlock") {
      writeIndentIfNeeded();
      if (previousEmitted && shouldSpaceBefore(previousEmitted, token, previousSignificant)) {
        result += " ";
      }
      result += token.value;
      previousEmitted = token;
      previousSignificant = token;
      continue;
    }

    if (token.type === "symbol" && token.value === "}") {
      if (!atLineStart) {
        writeNewline();
      }
      indentLevel = Math.max(0, indentLevel - 1);
      writeIndentIfNeeded();
      result += token.value;
      previousEmitted = token;
      previousSignificant = token;
      const next = tokens[index + 1];
      if (next && next.type === "identifier" && next.value === "else") {
        result += " ";
        atLineStart = false;
        previousEmitted = undefined;
        continue;
      }
      if (next && !(next.type === "symbol" && (next.value === ";" || next.value === "," || next.value === ")" || next.value === "]" || next.value === "."))) {
        writeNewline();
      }
      continue;
    }

    writeIndentIfNeeded();

    if (previousEmitted && shouldSpaceBefore(previousEmitted, token, previousSignificant)) {
      result += " ";
    }

    result += token.value;
    previousEmitted = token;
    previousSignificant = token;

    if (token.type === "symbol") {
      if (token.value === "{") {
        indentLevel += 1;
        writeNewline();
        continue;
      }
      if (token.value === ";") {
        if (parenDepth === 0 && bracketDepth === 0) {
          writeNewline();
        } else {
          result += " ";
          atLineStart = false;
          previousEmitted = undefined;
        }
        continue;
      }
      if (token.value === ":" && previousSignificant?.type === "identifier" && (previousSignificant.value === "case" || previousSignificant.value === "default")) {
        writeNewline();
        continue;
      }
      if (token.value === "(") {
        parenDepth += 1;
      } else if (token.value === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
      } else if (token.value === "[") {
        bracketDepth += 1;
      } else if (token.value === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
      }
    }
  }

  return result.trimEnd();
}
