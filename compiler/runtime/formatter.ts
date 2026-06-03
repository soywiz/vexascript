interface FormatToken {
  type: "identifier" | "number" | "string" | "regexp" | "commentLine" | "commentBlock" | "symbol" | "newline";
  value: string;
}

type TopLevelLineKind = "variableDeclaration" | "functionOrClassDeclaration" | "other";

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
  "??",
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
  "...",
  "?.",
  "!."
] as const;

const UNARY_PREFIX_OPERATORS = new Set(["+", "-", "++", "--", "!", "~"]);
const BINARY_OPERATORS = new Set([
  "+", "-", "*", "/", "%", "**",
  "<<", ">>", ">>>",
  "...",
  "<", ">", "<=", ">=",
  "==", "!=", "===", "!==",
  "&", "|", "^", "&&", "||",
  "=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", ">>>=", "&=", "|=", "&&=", "||="
  , "??="
  , "??"
]);

const CONTROL_KEYWORDS_WITH_PAREN = new Set(["if", "for", "while", "with", "switch", "catch"]);

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string): boolean {
  return /[0-9]/.test(ch);
}

function charAtOrEmpty(source: string, index: number): string {
  return source[index] ?? "";
}

function previousSignificantFormatToken(tokens: FormatToken[]): FormatToken | undefined {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token && token.type !== "newline" && token.type !== "commentLine" && token.type !== "commentBlock") {
      return token;
    }
  }
  return undefined;
}

function formatTokenAllowsRegExpLiteral(previousToken: FormatToken | undefined): boolean {
  if (!previousToken) {
    return true;
  }
  if (previousToken.type === "identifier") {
    return ["return", "throw", "case", "delete", "void", "typeof", "await", "yield", "in", "instanceof", "new", "else", "do", "of"].includes(previousToken.value);
  }
  if (previousToken.type === "symbol") {
    return new Set([
      "(", "{", "[", ",", ";", ":", "=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", ">>>=",
      "&=", "|=", "&&=", "||=", "??=", "?", "=>", "->", "||", "&&", "??", "|", "^", "&",
      "==", "!=", "===", "!==", "<", ">", "<=", ">=", "+", "-", "*", "/", "%", "**", "!", "~", "..."
    ]).has(previousToken.value);
  }
  return false;
}

function readFormatRegExpLiteral(source: string, start: number): number {
  let index = start + 1;
  let escaped = false;
  let inCharacterClass = false;

  while (index < source.length) {
    const ch = charAtOrEmpty(source, index);
    if (ch === "\n" || ch === "\r") {
      return start + 1;
    }
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      index += 1;
      continue;
    }
    if (ch === "[") {
      inCharacterClass = true;
      index += 1;
      continue;
    }
    if (ch === "]") {
      inCharacterClass = false;
      index += 1;
      continue;
    }
    if (ch === "/" && !inCharacterClass) {
      index += 1;
      while (index < source.length && isIdentifierPart(charAtOrEmpty(source, index))) {
        index += 1;
      }
      return index;
    }
    index += 1;
  }

  return start + 1;
}

function tokenizeForFormatting(source: string): FormatToken[] {
  const tokens: FormatToken[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = charAtOrEmpty(source, i);

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

    if (ch === "/" && charAtOrEmpty(source, i + 1) === "/") {
      const start = i;
      i += 2;
      while (i < source.length && charAtOrEmpty(source, i) !== "\n") {
        i += 1;
      }
      tokens.push({ type: "commentLine", value: source.slice(start, i) });
      continue;
    }

    if (ch === "/" && charAtOrEmpty(source, i + 1) === "*") {
      const start = i;
      i += 2;
      while (i < source.length && !(charAtOrEmpty(source, i) === "*" && charAtOrEmpty(source, i + 1) === "/")) {
        i += 1;
      }
      if (i < source.length) {
        i += 2;
      }
      tokens.push({ type: "commentBlock", value: source.slice(start, i) });
      continue;
    }

    if (
      ch === "/" &&
      charAtOrEmpty(source, i + 1) !== "/" &&
      charAtOrEmpty(source, i + 1) !== "*" &&
      charAtOrEmpty(source, i + 1) !== "=" &&
      formatTokenAllowsRegExpLiteral(previousSignificantFormatToken(tokens))
    ) {
      const end = readFormatRegExpLiteral(source, i);
      if (end > i + 1) {
        tokens.push({ type: "regexp", value: source.slice(i, end) });
        i = end;
        continue;
      }
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < source.length) {
        if (charAtOrEmpty(source, i) === "\\") {
          i += 2;
          continue;
        }
        if (charAtOrEmpty(source, i) === quote) {
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
      while (i < source.length && isIdentifierPart(charAtOrEmpty(source, i))) {
        i += 1;
      }
      tokens.push({ type: "identifier", value: source.slice(start, i) });
      continue;
    }

    if (isDigit(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && /[0-9]/.test(charAtOrEmpty(source, i))) {
        i += 1;
      }
      if (i + 1 < source.length && charAtOrEmpty(source, i) === "." && /[0-9]/.test(charAtOrEmpty(source, i + 1))) {
        i += 1;
        while (i < source.length && /[0-9]/.test(charAtOrEmpty(source, i))) {
          i += 1;
        }
      }
      if (i < source.length && (charAtOrEmpty(source, i) === "e" || charAtOrEmpty(source, i) === "E")) {
        let exponentIndex = i + 1;
        if (exponentIndex < source.length && (charAtOrEmpty(source, exponentIndex) === "+" || charAtOrEmpty(source, exponentIndex) === "-")) {
          exponentIndex += 1;
        }
        if (exponentIndex < source.length && /[0-9]/.test(charAtOrEmpty(source, exponentIndex))) {
          i = exponentIndex + 1;
          while (i < source.length && /[0-9]/.test(charAtOrEmpty(source, i))) {
            i += 1;
          }
        }
      }
      if (i < source.length && (charAtOrEmpty(source, i) === "n" || charAtOrEmpty(source, i) === "N" || charAtOrEmpty(source, i) === "L")) {
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

    tokens.push({ type: "symbol", value: ch || "" });
    i += 1;
  }

  return tokens;
}

function isWordLike(token: FormatToken | undefined): boolean {
  if (!token) {
    return false;
  }
  return token.type === "identifier" || token.type === "number" || token.type === "string" || token.type === "regexp";
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

function classifyTopLevelLineStart(token: FormatToken): TopLevelLineKind {
  if (token.type !== "identifier") {
    return "other";
  }

  if (token.value === "let" || token.value === "var" || token.value === "val" || token.value === "const") {
    return "variableDeclaration";
  }

  if (token.value === "fun" || token.value === "function" || token.value === "async" || token.value === "class" || token.value === "enum" || token.value === "interface" || token.value === "type") {
    return "functionOrClassDeclaration";
  }

  return "other";
}

function shouldSpaceBefore(
  previous: FormatToken | undefined,
  current: FormatToken,
  previousSignificant: FormatToken | undefined,
  significantBeforePrevious: FormatToken | undefined,
  nextToken: FormatToken | undefined
): boolean {
  if (!previous) {
    return false;
  }

  if (isMemberOperator(previous) || isMemberOperator(current)) {
    return false;
  }
  if (current.type === "symbol" && current.value === "*" && previous.type === "identifier" && previous.value === "function") {
    return false;
  }

  if (previous.type === "symbol" && previous.value === "*" && significantBeforePrevious?.type === "identifier" && significantBeforePrevious.value === "function") {
    return false;
  }


  if (
    previous.type === "symbol" &&
    previous.value === "..." &&
    significantBeforePrevious?.type === "symbol" &&
    (significantBeforePrevious.value === "(" || significantBeforePrevious.value === "[" || significantBeforePrevious.value === ",")
  ) {
    return false;
  }

  if (current.type === "symbol" && (current.value === ")" || current.value === "]" || current.value === "}" || current.value === "," || current.value === ";")) {
    return false;
  }

  if (previous.type === "symbol" && (previous.value === "(" || previous.value === "[" || previous.value === "{")) {
    return false;
  }

  if (current.type === "symbol" && current.value === ":") {
    if (previousSignificant?.type === "symbol" && previousSignificant.value === "?") {
      return true;
    }
    if (significantBeforePrevious?.type === "symbol" && significantBeforePrevious.value === "?") {
      return true;
    }
    if (previousSignificant?.type === "identifier" && (previousSignificant.value === "case" || previousSignificant.value === "default")) {
      return false;
    }
    return false;
  }

  if (current.type === "symbol" && current.value === "?") {
    if (
      previous?.type === "identifier" &&
      nextToken?.type === "symbol" &&
      (nextToken.value === "," || nextToken.value === ")" || nextToken.value === ":")
    ) {
      return false;
    }
    return true;
  }

  if (previous.type === "symbol" && previous.value === "?") {
    return true;
  }

  if (current.type === "symbol" && current.value === "{") {
    return !!previousSignificant && !(previousSignificant.type === "symbol" && previousSignificant.value === "{");
  }

  if (previous.type === "symbol" && (previous.value === "," || previous.value === ":")) {
    return true;
  }

  if (current.type === "symbol" && current.value === "(") {
    return (
      (previous.type === "identifier" && CONTROL_KEYWORDS_WITH_PAREN.has(previous.value)) ||
      (previous.type === "symbol" && isBinaryOperatorToken(previous, significantBeforePrevious))
    );
  }

  if (isBinaryOperatorToken(current, previousSignificant)) {
    return true;
  }

  if (previous.type === "symbol" && isBinaryOperatorToken(previous, significantBeforePrevious)) {
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

function nextNonNewlineToken(tokens: FormatToken[], index: number): FormatToken | undefined {
  for (let i = index + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    if (token.type !== "newline") {
      return token;
    }
  }
  return undefined;
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
  let significantBeforePrevious: FormatToken | undefined;
  let previousTopLevelLineKind: TopLevelLineKind | undefined;
  let currentTopLevelLineKind: TopLevelLineKind | undefined;

  const writeIndentIfNeeded = (): void => {
    if (atLineStart) {
      result += INDENT.repeat(Math.max(indentLevel, 0));
      atLineStart = false;
    }
  };

  const writeNewline = (): void => {
    result = result.replace(/[ \t]+$/g, "");
    if (currentTopLevelLineKind) {
      previousTopLevelLineKind = currentTopLevelLineKind;
      currentTopLevelLineKind = undefined;
    }
    if (!result.endsWith("\n")) {
      result += "\n";
    }
    atLineStart = true;
    previousEmitted = undefined;
  };

  const beginLineIfNeeded = (token: FormatToken): void => {
    if (!atLineStart) {
      return;
    }

    if (indentLevel === 0) {
      const currentKind = classifyTopLevelLineStart(token);
      currentTopLevelLineKind = currentKind;
      if (
        previousTopLevelLineKind &&
        (previousTopLevelLineKind === "functionOrClassDeclaration" || currentKind === "functionOrClassDeclaration") &&
        !result.endsWith("\n\n")
      ) {
        result = result.replace(/[ \t]+$/g, "");
        if (!result.endsWith("\n")) {
          result += "\n";
        }
        result += "\n";
      }
    } else {
      currentTopLevelLineKind = undefined;
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    if (token.type === "newline") {
      if (parenDepth === 0 && bracketDepth === 0) {
        let newlineRunLength = 1;
        while (
          index + newlineRunLength < tokens.length &&
          tokens[index + newlineRunLength]?.type === "newline"
        ) {
          newlineRunLength += 1;
        }

        if (!atLineStart) {
          writeNewline();
        }

        if (newlineRunLength > 1 && !result.endsWith("\n\n")) {
          // Preserve user-authored blank lines while collapsing long runs to one empty line.
          result += "\n";
        }

        index += newlineRunLength - 1;
      }
      continue;
    }

    if (token.type === "commentLine") {
      beginLineIfNeeded(token);
      writeIndentIfNeeded();
      const nextToken = nextNonNewlineToken(tokens, index);
      if (previousEmitted && shouldSpaceBefore(previousEmitted, token, previousSignificant, significantBeforePrevious, nextToken)) {
        result += " ";
      }
      result += token.value;
      previousEmitted = token;
      significantBeforePrevious = previousSignificant;
      previousSignificant = token;
      writeNewline();
      continue;
    }

    if (token.type === "commentBlock") {
      beginLineIfNeeded(token);
      writeIndentIfNeeded();
      const nextToken = nextNonNewlineToken(tokens, index);
      if (previousEmitted && shouldSpaceBefore(previousEmitted, token, previousSignificant, significantBeforePrevious, nextToken)) {
        result += " ";
      }
      result += token.value;
      previousEmitted = token;
      significantBeforePrevious = previousSignificant;
      previousSignificant = token;
      continue;
    }

    if (token.type === "symbol" && token.value === "}") {
      beginLineIfNeeded(token);
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

    beginLineIfNeeded(token);
    writeIndentIfNeeded();

    const nextToken = nextNonNewlineToken(tokens, index);
    if (previousEmitted && shouldSpaceBefore(previousEmitted, token, previousSignificant, significantBeforePrevious, nextToken)) {
      result += " ";
    }

    result += token.value;
    previousEmitted = token;
    significantBeforePrevious = previousSignificant;
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
