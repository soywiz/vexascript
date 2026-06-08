interface FormatToken {
  type: "identifier" | "number" | "string" | "regexp" | "commentLine" | "commentBlock" | "symbol" | "jsx" | "newline";
  value: string;
}

type TopLevelLineKind = "variableDeclaration" | "functionOrClassDeclaration" | "other";
type GenericAngleRole = "open" | "close" | "splitClose" | undefined;
interface GenericAngleClassification {
  emittedOverrides: Array<string | undefined>;
  roles: Array<GenericAngleRole>;
  inside: boolean[];
}

const INDENT = "  ";
const IMPORT_PRINT_WIDTH = 80;

const MULTI_CHAR_SYMBOLS = [
  ">>>=",
  "===",
  "!==",
  "<<=",
  ">>=",
  ">>>",
  "=>",
  "->",
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
  "..<",
  "?.",
  "!."
] as const;

const UNARY_PREFIX_OPERATORS = new Set(["+", "-", "++", "--", "!", "~"]);
const BINARY_OPERATORS = new Set([
  "+", "-", "*", "/", "%", "**",
  "<<", ">>", ">>>",
  "...", "..<",
  "<", ">", "<=", ">=",
  "==", "!=", "===", "!==",
  "=>", "->",
  "&", "|", "^", "&&", "||",
  "=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", ">>>=", "&=", "|=", "&&=", "||="
  , "??="
  , "??"
]);

const CONTROL_KEYWORDS_WITH_PAREN = new Set(["if", "for", "while", "with", "switch", "catch"]);
// Keywords that may begin a statement inside a block body. When a `{` block opens
// with one of these, it is a statement block rather than a lambda parameter header.
const STATEMENT_LEADING_KEYWORDS = new Set([
  "if", "for", "while", "with", "switch", "catch", "do", "try", "return", "throw",
  "break", "continue", "let", "var", "val", "const", "function", "fun", "class",
  "enum", "interface", "type", "async", "sync", "await", "yield", "new", "delete",
  "void", "typeof", "import", "export", "case", "default", "else"
]);
const VARIABLE_DECLARATION_KEYWORDS = new Set(["let", "var", "val", "const"]);

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
      "==", "!=", "===", "!==", "<", ">", "<=", ">=", "+", "-", "*", "/", "%", "**", "!", "~", "...", "..<"
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

function skipFormatString(source: string, start: number): number {
  const quote = charAtOrEmpty(source, start);
  let index = start + 1;
  while (index < source.length) {
    const ch = charAtOrEmpty(source, index);
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === quote) {
      return index + 1;
    }
    index += 1;
  }
  return index;
}

// Skips a balanced `{ ... }` block (used for JSX expression containers),
// ignoring braces that appear inside string/template literals.
function skipFormatBraces(source: string, start: number): number {
  let index = start;
  let depth = 0;
  while (index < source.length) {
    const ch = charAtOrEmpty(source, index);
    if (ch === '"' || ch === "'" || ch === "`") {
      index = skipFormatString(source, index);
      continue;
    }
    if (ch === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      index += 1;
      if (depth === 0) {
        return index;
      }
      continue;
    }
    index += 1;
  }
  return index;
}

/**
 * Scans a complete embedded XML/JSX element starting at `<` and returns the
 * index just past its closing tag. The formatter captures the element verbatim
 * so its internal layout is preserved rather than reflowed.
 */
function readFormatJsx(source: string, start: number): number {
  let index = start;
  let depth = 0;
  while (index < source.length) {
    const ch = charAtOrEmpty(source, index);
    if (ch === "<") {
      if (charAtOrEmpty(source, index + 1) === "/") {
        // Closing tag.
        index += 2;
        while (index < source.length && charAtOrEmpty(source, index) !== ">") {
          index += 1;
        }
        if (index < source.length) {
          index += 1;
        }
        depth -= 1;
        if (depth <= 0) {
          return index;
        }
        continue;
      }
      // Opening tag (or fragment `<>`).
      index += 1;
      let selfClosing = false;
      while (index < source.length) {
        const c = charAtOrEmpty(source, index);
        if (c === '"' || c === "'") {
          index = skipFormatString(source, index);
          continue;
        }
        if (c === "{") {
          index = skipFormatBraces(source, index);
          continue;
        }
        if (c === "/" && charAtOrEmpty(source, index + 1) === ">") {
          selfClosing = true;
          index += 2;
          break;
        }
        if (c === ">") {
          index += 1;
          break;
        }
        index += 1;
      }
      if (!selfClosing) {
        depth += 1;
      } else if (depth === 0) {
        return index;
      }
      continue;
    }
    if (ch === "{") {
      index = skipFormatBraces(source, index);
      continue;
    }
    index += 1;
  }
  return index;
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

    if (
      ch === "<" &&
      formatTokenAllowsRegExpLiteral(previousSignificantFormatToken(tokens)) &&
      (isIdentifierStart(charAtOrEmpty(source, i + 1)) || charAtOrEmpty(source, i + 1) === ">")
    ) {
      const end = readFormatJsx(source, i);
      if (end > i) {
        tokens.push({ type: "jsx", value: source.slice(i, end) });
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
  return token.type === "identifier" || token.type === "number" || token.type === "string" || token.type === "regexp" || token.type === "jsx";
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

  if (token.value === "fun" || token.value === "function" || token.value === "async" || token.value === "sync" || token.value === "class" || token.value === "enum" || token.value === "interface" || token.value === "type") {
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
  if (current.type === "symbol" && current.value === "*" && previous.type === "identifier" && previous.value === "operator") {
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

  if (current.type === "symbol" && current.value === "," && previous.type === "symbol" && previous.value === ",") return true;
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

  if (current.type === "symbol" && (current.value === "{" || current.value === "[")) {
    if (previousSignificant?.type === "identifier" && VARIABLE_DECLARATION_KEYWORDS.has(previousSignificant.value)) return true;
    if (current.value === "{") return !!previousSignificant && !(previousSignificant.type === "symbol" && previousSignificant.value === "{");
  }

  if (previous.type === "symbol" && (previous.value === "," || previous.value === ":")) {
    return true;
  }

  if (current.type === "symbol" && current.value === "(") {
    if (previous.type === "symbol" && previous.value === "*" && significantBeforePrevious?.type === "identifier" && significantBeforePrevious.value === "operator") {
      return false;
    }
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

// Detects whether the block opened by `{` at `openBraceIndex` is a brace lambda
// with an explicit parameter header (e.g. `{ resolve, reject -> ... }`). Returns
// the index of the header-terminating `->` token, or -1 when the block is not a
// parameter-headed lambda. Mirrors the parser's tail-lambda detection: the header
// must start with an identifier and reach a `->` at the brace's own nesting level.
function lambdaHeaderArrowIndex(tokens: FormatToken[], openBraceIndex: number): number {
  let firstIndex = openBraceIndex + 1;
  while (firstIndex < tokens.length && tokens[firstIndex]?.type === "newline") {
    firstIndex += 1;
  }
  const firstToken = tokens[firstIndex];
  if (firstToken?.type !== "identifier" || STATEMENT_LEADING_KEYWORDS.has(firstToken.value)) {
    return -1;
  }

  let nestedDelimiters = 0;
  for (let index = openBraceIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.type !== "symbol") {
      continue;
    }
    if (token.value === "(" || token.value === "[" || token.value === "{") {
      nestedDelimiters += 1;
      continue;
    }
    if (token.value === ")" || token.value === "]" || token.value === "}") {
      if (nestedDelimiters === 0) {
        return -1;
      }
      nestedDelimiters -= 1;
      continue;
    }
    if (nestedDelimiters === 0) {
      if (token.value === ";") {
        return -1;
      }
      if (token.value === "->") {
        return index;
      }
    }
  }
  return -1;
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

function previousNonTriviaToken(tokens: FormatToken[], index: number): FormatToken | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    if (token.type !== "newline" && token.type !== "commentLine" && token.type !== "commentBlock") {
      return token;
    }
  }
  return undefined;
}

function isFQNameStartToken(token: FormatToken | undefined): boolean {
  return !!token && token.type === "identifier";
}

function isFQNameContinuationToken(token: FormatToken | undefined, expectIdentifier: boolean): boolean {
  if (!token) {
    return false;
  }
  if (expectIdentifier) {
    return token.type === "identifier";
  }
  return token.type === "symbol" && token.value === ".";
}

function genericCloseCount(symbol: string, pendingGenericDepth: number): number {
  if (symbol === ">" || symbol === ">=") {
    return Math.min(1, pendingGenericDepth);
  }
  if (symbol === ">>" || symbol === ">>=") {
    return Math.min(2, pendingGenericDepth);
  }
  if (symbol === ">>>" || symbol === ">>>=") {
    return Math.min(3, pendingGenericDepth);
  }
  return 0;
}

function detectGenericAngleRoles(tokens: FormatToken[]): GenericAngleClassification {
  const emittedOverrides: Array<string | undefined> = new Array(tokens.length).fill(undefined);
  const roles: Array<GenericAngleRole> = new Array(tokens.length).fill(undefined);
  const inside = new Array(tokens.length).fill(false);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.type !== "symbol" || token.value !== "<" || inside[index]) {
      continue;
    }

    const previous = previousNonTriviaToken(tokens, index);
    const next = nextNonNewlineToken(tokens, index);
    if (previous?.type !== "identifier" || !isFQNameStartToken(next)) {
      continue;
    }

    let cursor = index + 1;
    let pendingGenericDepth = 1;
    let expectIdentifier = true;
    let valid = true;
    const visitedIndexes: number[] = [index];
    let endIndex = -1;

    while (cursor < tokens.length) {
      const current = tokens[cursor];
      visitedIndexes.push(cursor);
      cursor += 1;

      if (!current || current.type === "commentLine" || current.type === "commentBlock") {
        continue;
      }
      if (current.type === "newline") {
        break;
      }
      if (expectIdentifier) {
        if (current.type === "symbol" && current.value === ">") {
          pendingGenericDepth -= 1;
          roles[cursor - 1] = "close";
          expectIdentifier = false;
          if (pendingGenericDepth === 0) {
            endIndex = cursor - 1;
            break;
          }
          continue;
        }
        const immediateCloseCount = current.type === "symbol" ? genericCloseCount(current.value, pendingGenericDepth) : 0;
        if (immediateCloseCount > 0) {
          const suffix = current.value.slice(immediateCloseCount);
          if (suffix.length > 0) {
            emittedOverrides[cursor - 1] = `${">".repeat(immediateCloseCount)} ${suffix}`;
          }
          const closeCount = immediateCloseCount;
          pendingGenericDepth -= closeCount;
          roles[cursor - 1] = "splitClose";
          expectIdentifier = false;
          if (pendingGenericDepth === 0) {
            endIndex = cursor - 1;
            break;
          }
          continue;
        }
        if (!isFQNameContinuationToken(current, true)) {
          valid = false;
          break;
        }
        expectIdentifier = false;
        continue;
      }

      if (current.type === "symbol" && current.value === ".") {
        expectIdentifier = true;
        continue;
      }
        if (current.type === "symbol" && current.value === "<") {
          const nestedNext = nextNonNewlineToken(tokens, cursor - 1);
          if (!isFQNameStartToken(nestedNext)) {
            valid = false;
            break;
          }
          pendingGenericDepth += 1;
          roles[cursor - 1] = "open";
          expectIdentifier = true;
          continue;
      }
      const closeCount = current.type === "symbol" ? genericCloseCount(current.value, pendingGenericDepth) : 0;
      if (closeCount > 0) {
        const suffix = current.value.slice(closeCount);
        if (suffix.length > 0) {
          emittedOverrides[cursor - 1] = `${">".repeat(closeCount)} ${suffix}`;
        }
        pendingGenericDepth -= closeCount;
        roles[cursor - 1] = closeCount === 1 && current.value === ">" ? "close" : "splitClose";
        if (pendingGenericDepth === 0) {
          endIndex = cursor - 1;
          break;
        }
        continue;
      }

      valid = false;
      break;
    }

    const tokenAfterSequence = endIndex >= 0 ? nextNonNewlineToken(tokens, endIndex) : undefined;
    const hasTrailingSuffix = endIndex >= 0 && !!emittedOverrides[endIndex];
    if (!valid || pendingGenericDepth !== 0 || (!hasTrailingSuffix && isWordLike(tokenAfterSequence))) {
      for (let reset = index; reset < cursor; reset += 1) {
        if (roles[reset] === "open" || roles[reset] === "close" || roles[reset] === "splitClose") {
          roles[reset] = undefined;
        }
      }
      continue;
    }

    roles[index] = "open";
    for (const visitedIndex of visitedIndexes) {
      inside[visitedIndex] = true;
    }
  }

  return { emittedOverrides, roles, inside };
}

interface CollectedImportStatement {
  stmt: FormatToken[];
  hasSemicolon: boolean;
  endIndex: number;
}

function isImportStatementStart(tokens: FormatToken[], index: number): boolean {
  const token = tokens[index];
  if (!token || token.type !== "identifier" || token.value !== "import") {
    return false;
  }
  const next = nextNonNewlineToken(tokens, index);
  if (!next) {
    return false;
  }
  // `import.meta` and dynamic `import(...)` are expressions, not import statements.
  if (next.type === "symbol" && (next.value === "." || next.value === "(")) {
    return false;
  }
  return true;
}

function collectImportStatement(tokens: FormatToken[], start: number): CollectedImportStatement | null {
  const stmt: FormatToken[] = [];
  let specifierIndex = -1;
  let cursor = start;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (!token) {
      cursor += 1;
      continue;
    }
    if (token.type === "newline") {
      cursor += 1;
      continue;
    }
    // Comments inside an import statement are rare; fall back to generic formatting
    // so their content is preserved rather than dropped.
    if (token.type === "commentLine" || token.type === "commentBlock") {
      return null;
    }
    if (token.type === "string") {
      stmt.push(token);
      specifierIndex = cursor;
      break;
    }
    // A terminator before the module specifier means this is not a well-formed import.
    if (token.type === "symbol" && token.value === ";") {
      return null;
    }
    stmt.push(token);
    cursor += 1;
  }

  if (specifierIndex < 0) {
    return null;
  }

  let endIndex = specifierIndex;
  let hasSemicolon = false;
  for (let look = specifierIndex + 1; look < tokens.length; look += 1) {
    const token = tokens[look];
    if (!token) {
      continue;
    }
    if (token.type === "newline") {
      break;
    }
    if (token.type === "symbol" && token.value === ";") {
      hasSemicolon = true;
      endIndex = look;
    }
    break;
  }

  return { stmt, hasSemicolon, endIndex };
}

function renderImportItem(itemTokens: FormatToken[]): string {
  let text = "";
  let sawOperatorKeyword = false;
  for (let index = 0; index < itemTokens.length; index += 1) {
    const token = itemTokens[index];
    if (!token) {
      continue;
    }
    if (text === "") {
      text += token.value;
    } else if (sawOperatorKeyword) {
      // Operator names such as `operator+` keep their symbols attached.
      text += token.value;
    } else {
      text += ` ${token.value}`;
    }
    if (token.type === "identifier" && token.value === "operator") {
      sawOperatorKeyword = true;
    }
  }
  return text;
}

function renderImportClauseOutside(tokens: FormatToken[]): string {
  let out = "";
  for (const token of tokens) {
    if (token.type === "symbol" && token.value === ",") {
      out = `${out.replace(/\s+$/g, "")}, `;
      continue;
    }
    if (out === "" || out.endsWith(" ")) {
      out += token.value;
    } else {
      out += ` ${token.value}`;
    }
  }
  return out;
}

function splitImportNamedItems(innerTokens: FormatToken[]): FormatToken[][] {
  const items: FormatToken[][] = [];
  let current: FormatToken[] = [];
  for (const token of innerTokens) {
    if (token.type === "symbol" && token.value === ",") {
      if (current.length > 0) {
        items.push(current);
      }
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) {
    items.push(current);
  }
  return items;
}

function formatImportStatementText(collected: CollectedImportStatement): string {
  const { stmt, hasSemicolon } = collected;
  const semicolon = hasSemicolon ? ";" : "";
  const specifier = stmt[stmt.length - 1];
  if (!specifier) {
    return "";
  }

  let clauseStartIndex = 1;
  const second = stmt[1];
  const isType =
    !!second &&
    second.type === "identifier" &&
    second.value === "type" &&
    !(stmt[2]?.type === "identifier" && stmt[2].value === "from");
  if (isType) {
    clauseStartIndex = 2;
  }
  const typePrefix = isType ? "type " : "";

  let fromIndex = -1;
  for (let index = clauseStartIndex; index < stmt.length - 1; index += 1) {
    const token = stmt[index];
    if (token && token.type === "identifier" && token.value === "from") {
      fromIndex = index;
      break;
    }
  }

  // Side-effect import: `import "module"`.
  if (fromIndex < 0) {
    return `import ${specifier.value}${semicolon}`;
  }

  const clauseTokens = stmt.slice(clauseStartIndex, fromIndex);
  let braceOpen = -1;
  let braceClose = -1;
  for (let index = 0; index < clauseTokens.length; index += 1) {
    const token = clauseTokens[index];
    if (token && token.type === "symbol" && token.value === "{") {
      braceOpen = index;
      break;
    }
  }
  if (braceOpen >= 0) {
    let depth = 0;
    for (let index = braceOpen; index < clauseTokens.length; index += 1) {
      const token = clauseTokens[index];
      if (token && token.type === "symbol" && token.value === "{") {
        depth += 1;
      } else if (token && token.type === "symbol" && token.value === "}") {
        depth -= 1;
        if (depth === 0) {
          braceClose = index;
          break;
        }
      }
    }
  }

  if (braceOpen < 0 || braceClose < 0) {
    // No named imports (default and/or namespace only): always a single line.
    const clause = renderImportClauseOutside(clauseTokens);
    return `import ${typePrefix}${clause} from ${specifier.value}${semicolon}`;
  }

  const beforeBrace = clauseTokens.slice(0, braceOpen);
  const innerTokens = clauseTokens.slice(braceOpen + 1, braceClose);
  const afterBrace = clauseTokens.slice(braceClose + 1);
  const items = splitImportNamedItems(innerTokens).map(renderImportItem);
  const beforeText = renderImportClauseOutside(beforeBrace);
  const afterText = renderImportClauseOutside(afterBrace);
  const namedBlock = items.length > 0 ? `{ ${items.join(", ")} }` : "{}";
  const clause = `${beforeText}${namedBlock}${afterText ? ` ${afterText}` : ""}`;
  const singleLine = `import ${typePrefix}${clause} from ${specifier.value}${semicolon}`;

  if (items.length === 0 || singleLine.length <= IMPORT_PRINT_WIDTH) {
    return singleLine;
  }

  // Too long: wrap the named bindings one per line, TypeScript-style.
  const bracePrefix = `import ${typePrefix}${beforeText}{`;
  const suffix = `}${afterText ? ` ${afterText}` : ""} from ${specifier.value}${semicolon}`;
  const lines = [bracePrefix];
  for (const item of items) {
    lines.push(`${INDENT}${item},`);
  }
  lines.push(suffix);
  return lines.join("\n");
}

interface FormattedImportBlock {
  text: string;
  count: number;
  endIndex: number;
}

function formatImportBlock(tokens: FormatToken[], start: number): FormattedImportBlock | null {
  const lines: string[] = [];
  let cursor = start;
  while (cursor < tokens.length && isImportStatementStart(tokens, cursor)) {
    const collected = collectImportStatement(tokens, cursor);
    if (!collected) {
      break;
    }
    lines.push(formatImportStatementText(collected));
    cursor = collected.endIndex + 1;
    // Collapse any blank lines between consecutive imports so the group stays together.
    while (cursor < tokens.length && tokens[cursor]?.type === "newline") {
      cursor += 1;
    }
  }

  if (lines.length === 0) {
    return null;
  }
  return { text: lines.join("\n"), count: lines.length, endIndex: cursor };
}

export function formatSource(source: string): string {
  const tokens = tokenizeForFormatting(source);
  const { emittedOverrides: genericEmittedOverrides, roles: genericAngleRoles, inside: genericInsideTokens } = detectGenericAngleRoles(tokens);

  let result = "";
  let indentLevel = 0;
  let atLineStart = true;
  let parenDepth = 0;
  let bracketDepth = 0;
  let bindingBraceDepth = 0;
  let awaitingVariableBinding = false;
  // Indices of `->` tokens that terminate a brace-lambda parameter header. The
  // header is kept on the same line as `{`; the body break is emitted after the `->`.
  const lambdaHeaderArrows = new Set<number>();

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
    awaitingVariableBinding = false;
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

    if (
      atLineStart &&
      indentLevel === 0 &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      bindingBraceDepth === 0 &&
      isImportStatementStart(tokens, index)
    ) {
      const block = formatImportBlock(tokens, index);
      if (block) {
        result = result.replace(/[ \t]+$/g, "");
        result += block.text;
        if (!result.endsWith("\n")) {
          result += "\n";
        }
        // Always separate the import group from the rest of the code with one blank line.
        if (block.endIndex < tokens.length) {
          result += "\n";
        }
        atLineStart = true;
        previousEmitted = undefined;
        previousSignificant = undefined;
        significantBeforePrevious = undefined;
        // Suppress the declaration-spacing rule for the first line after imports,
        // since the blank line separator was already emitted.
        previousTopLevelLineKind = undefined;
        currentTopLevelLineKind = undefined;
        index = block.endIndex - 1;
        continue;
      }
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

    if (token.type === "symbol" && token.value === "}" && bindingBraceDepth > 0) {
      beginLineIfNeeded(token);
      writeIndentIfNeeded();
      if (!result.endsWith(" ") && previousEmitted?.value !== "{") result += " ";
      result += token.value;
      bindingBraceDepth -= 1;
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
    const genericRole = genericAngleRoles[index];
    const previousInsideGeneric = index > 0 ? genericInsideTokens[index - 1] : false;
    const currentInsideGeneric = genericInsideTokens[index];
    const suppressLeadingSpace =
      genericRole === "open" ||
      genericRole === "close" ||
      genericRole === "splitClose" ||
      (previousEmitted?.type === "symbol" && previousEmitted.value === "<" && currentInsideGeneric) ||
      (previousEmitted?.type === "symbol" && previousEmitted.value === ">" && currentInsideGeneric) ||
      ((previousEmitted?.type === "symbol" && previousEmitted.value === ">") || genericRole === "splitClose") &&
        token.type === "symbol" &&
        token.value === "(" ||
      (previousInsideGeneric && token.type === "symbol" && token.value === ".") ||
      (previousEmitted?.type === "symbol" && previousEmitted.value === "." && currentInsideGeneric);
    if (previousEmitted && !suppressLeadingSpace && shouldSpaceBefore(previousEmitted, token, previousSignificant, significantBeforePrevious, nextToken)) {
      result += " ";
    }

    if (genericEmittedOverrides[index]) {
      result += genericEmittedOverrides[index];
    } else if (genericRole === "splitClose" && token.type === "symbol") {
      result += ">".repeat(genericCloseCount(token.value, 3));
    } else {
      result += token.value;
    }
    if (token.type === "identifier" && VARIABLE_DECLARATION_KEYWORDS.has(token.value)) awaitingVariableBinding = true;
    if (token.type === "symbol" && token.value === "=") awaitingVariableBinding = false;
    previousEmitted = token;
    significantBeforePrevious = previousSignificant;
    previousSignificant = token;

    if (token.type === "symbol" && token.value === "->" && lambdaHeaderArrows.has(index)) {
      writeNewline();
      continue;
    }

    if (token.type === "symbol") {
      if (token.value === "{" && (awaitingVariableBinding || bindingBraceDepth > 0)) {
        bindingBraceDepth += 1;
        result += " ";
        continue;
      }
      if (token.value === "{") {
        indentLevel += 1;
        const arrowIndex = lambdaHeaderArrowIndex(tokens, index);
        if (arrowIndex >= 0) {
          // Keep the lambda parameter header (e.g. `resolve, reject ->`) on the
          // same line as the opening brace; the body break happens after `->`.
          lambdaHeaderArrows.add(arrowIndex);
          result += " ";
          continue;
        }
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
        awaitingVariableBinding = false;
      } else if (token.value === "[") {
        bracketDepth += 1;
      } else if (token.value === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
      }
    }
  }

  return result.trimEnd();
}
