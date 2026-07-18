import { parseSource } from "../pipeline/parse";
import type {
  AnnotationApplication, ArrayBindingPattern, ArrayLiteral,
  ArrowFunctionExpression, AssignmentExpression, AsExpression,
  BigIntLiteral, BinaryExpression, BindingElement, BindingName,
  BlockStatement, BooleanLiteral, BreakStatement, CallExpression,
  ChainExpression,
  ClassExpression,
  ClassFieldMember, ClassMethodMember, ClassPrimaryConstructorParameter,
  ClassStatement, CommaExpression, ConditionalExpression,
  ContinueStatement, DeferStatement, DoWhileStatement,
  EnumStatement, ExportSpecifier, ExportStatement,
  Expr, ExprStatement, ForStatement,
  FunctionExpression, FunctionParameter, FunctionStatement,
  Identifier, IfStatement, ImportStatement,
  InterfaceStatement, IntLiteral, JsxElement, JsxFragment,
  LabeledStatement, LongLiteral, MemberExpression,
  NamedArgument, NamespaceStatement, NewExpression, Node,
  NonNullExpression, ObjectBindingPattern,
  ObjectLiteral, ObjectProperty, ObjectSpreadProperty,
  Program, RangeExpression, RegExpLiteral, ReturnStatement,
  SatisfiesExpression,
  SpreadExpression, Statement, StringLiteral, SwitchStatement,
  ThrowStatement, TryStatement, TypeAliasStatement, TypeParameter,
  TypeReference, ArrayTypeAnnotation,
  UnaryExpression, UpdateExpression, VarStatement, WhileStatement,
  WithStatement
} from "../ast/ast";
import type { Token } from "../parser/tokenizer";

// === LEGACY TOKEN-BASED FORMATTER (all renamed with Legacy suffix) ===

interface FormatTokenLegacy {
  type: "identifier" | "number" | "string" | "regexp" | "commentLine" | "commentBlock" | "symbol" | "jsx" | "newline";
  value: string;
}

type TopLevelLineKindLegacy = "variableDeclaration" | "functionOrClassDeclaration" | "docComment" | "other";
type GenericAngleRoleLegacy = "open" | "close" | "splitClose" | undefined;
interface GenericAngleClassificationLegacy {
  emittedOverrides: Array<string | undefined>;
  roles: Array<GenericAngleRoleLegacy>;
  inside: boolean[];
}

const INDENT = "  ";
const IMPORT_PRINT_WIDTH = 80;

const MULTI_CHAR_SYMBOLS_LEGACY = [
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
  "..",
  "?.",
  "!."
] as const;

const UNARY_PREFIX_OPERATORS_LEGACY = new Set(["+", "-", "++", "--", "!", "~"]);
const BINARY_OPERATORS_LEGACY = new Set([
  "+", "-", "*", "/", "%", "**",
  "<<", ">>", ">>>",
  "...", "..<",
  "<", ">", "<=", ">=",
  "==", "!=", "===", "!==",
  "=>", "->",
  "&", "|", "^", "&&", "||",
  "=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||="
  , "??="
  , "??"
]);

const CONTROL_KEYWORDS_WITH_PAREN_LEGACY = new Set(["if", "for", "while", "with", "switch", "catch"]);
// Keywords that may begin a statement inside a block body. When a `{` block opens
// with one of these, it is a statement block rather than a lambda parameter header.
const STATEMENT_LEADING_KEYWORDS_LEGACY = new Set([
  "if", "for", "while", "with", "switch", "catch", "do", "try", "return", "throw",
  "break", "continue", "defer", "let", "var", "val", "const", "function", "fun", "class",
  "enum", "interface", "type", "async", "sync", "await", "yield", "new", "delete",
  "void", "typeof", "import", "export", "case", "default", "else"
]);
const VARIABLE_DECLARATION_KEYWORDS_LEGACY = new Set(["let", "var", "val", "const"]);

function isIdentifierStartLegacy(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentifierPartLegacy(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isDigitLegacy(ch: string): boolean {
  return /[0-9]/.test(ch);
}

function charAtOrEmptyLegacy(source: string, index: number): string {
  return source[index] ?? "";
}

function previousSignificantFormatTokenLegacy(tokens: FormatTokenLegacy[]): FormatTokenLegacy | undefined {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token && token.type !== "newline" && token.type !== "commentLine" && token.type !== "commentBlock") {
      return token;
    }
  }
  return undefined;
}

function formatTokenAllowsRegExpLiteralLegacy(previousToken: FormatTokenLegacy | undefined): boolean {
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

function readFormatRegExpLiteralLegacy(source: string, start: number): number {
  let index = start + 1;
  let escaped = false;
  let inCharacterClass = false;

  while (index < source.length) {
    const ch = charAtOrEmptyLegacy(source, index);
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
      while (index < source.length && isIdentifierPartLegacy(charAtOrEmptyLegacy(source, index))) {
        index += 1;
      }
      return index;
    }
    index += 1;
  }

  return start + 1;
}

function skipFormatStringLegacy(source: string, start: number): number {
  const quote = charAtOrEmptyLegacy(source, start);
  let index = start + 1;
  while (index < source.length) {
    const ch = charAtOrEmptyLegacy(source, index);
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

function skipFormatTemplateLegacy(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const ch = charAtOrEmptyLegacy(source, index);
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === "$" && charAtOrEmptyLegacy(source, index + 1) === "{") {
      index = skipFormatBracesLegacy(source, index + 1);
      continue;
    }
    if (ch === "`") {
      return index + 1;
    }
    index += 1;
  }
  return index;
}

// Skips a balanced `{ ... }` block (used for JSX expression containers),
// ignoring braces that appear inside string/template literals.
function skipFormatBracesLegacy(source: string, start: number): number {
  let index = start;
  let depth = 0;
  while (index < source.length) {
    const ch = charAtOrEmptyLegacy(source, index);
    if (ch === '"' || ch === "'") {
      index = skipFormatStringLegacy(source, index);
      continue;
    }
    if (ch === "`") {
      index = skipFormatTemplateLegacy(source, index);
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
function readFormatJsxLegacy(source: string, start: number): number {
  let index = start;
  let depth = 0;
  while (index < source.length) {
    const ch = charAtOrEmptyLegacy(source, index);
    if (ch === "<") {
      if (charAtOrEmptyLegacy(source, index + 1) === "/") {
        // Closing tag.
        index += 2;
        while (index < source.length && charAtOrEmptyLegacy(source, index) !== ">") {
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
        const c = charAtOrEmptyLegacy(source, index);
        if (c === '"' || c === "'") {
          index = skipFormatStringLegacy(source, index);
          continue;
        }
        if (c === "{") {
          index = skipFormatBracesLegacy(source, index);
          continue;
        }
        if (c === "/" && charAtOrEmptyLegacy(source, index + 1) === ">") {
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
      index = skipFormatBracesLegacy(source, index);
      continue;
    }
    index += 1;
  }
  return index;
}

function tokenizeForFormattingLegacy(source: string): FormatTokenLegacy[] {
  const tokens: FormatTokenLegacy[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = charAtOrEmptyLegacy(source, i);

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

    if (ch === "/" && charAtOrEmptyLegacy(source, i + 1) === "/") {
      const start = i;
      i += 2;
      while (i < source.length && charAtOrEmptyLegacy(source, i) !== "\n") {
        i += 1;
      }
      tokens.push({ type: "commentLine", value: source.slice(start, i) });
      continue;
    }

    if (ch === "/" && charAtOrEmptyLegacy(source, i + 1) === "*") {
      const start = i;
      i += 2;
      while (i < source.length && !(charAtOrEmptyLegacy(source, i) === "*" && charAtOrEmptyLegacy(source, i + 1) === "/")) {
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
      charAtOrEmptyLegacy(source, i + 1) !== "/" &&
      charAtOrEmptyLegacy(source, i + 1) !== "*" &&
      charAtOrEmptyLegacy(source, i + 1) !== "=" &&
      formatTokenAllowsRegExpLiteralLegacy(previousSignificantFormatTokenLegacy(tokens))
    ) {
      const end = readFormatRegExpLiteralLegacy(source, i);
      if (end > i + 1) {
        tokens.push({ type: "regexp", value: source.slice(i, end) });
        i = end;
        continue;
      }
    }

    if (
      ch === "<" &&
      formatTokenAllowsRegExpLiteralLegacy(previousSignificantFormatTokenLegacy(tokens)) &&
      (isIdentifierStartLegacy(charAtOrEmptyLegacy(source, i + 1)) || charAtOrEmptyLegacy(source, i + 1) === ">")
    ) {
      const end = readFormatJsxLegacy(source, i);
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
        if (charAtOrEmptyLegacy(source, i) === "\\") {
          i += 2;
          continue;
        }
        if (charAtOrEmptyLegacy(source, i) === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ type: "string", value: source.slice(start, i) });
      continue;
    }

    if (ch === "`") {
      const start = i;
      i = skipFormatTemplateLegacy(source, i);
      tokens.push({ type: "string", value: source.slice(start, i) });
      continue;
    }

    if (isIdentifierStartLegacy(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && isIdentifierPartLegacy(charAtOrEmptyLegacy(source, i))) {
        i += 1;
      }
      tokens.push({ type: "identifier", value: source.slice(start, i) });
      continue;
    }

    if (isDigitLegacy(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && /[0-9]/.test(charAtOrEmptyLegacy(source, i))) {
        i += 1;
      }
      if (i + 1 < source.length && charAtOrEmptyLegacy(source, i) === "." && /[0-9]/.test(charAtOrEmptyLegacy(source, i + 1))) {
        i += 1;
        while (i < source.length && /[0-9]/.test(charAtOrEmptyLegacy(source, i))) {
          i += 1;
        }
      }
      if (i < source.length && (charAtOrEmptyLegacy(source, i) === "e" || charAtOrEmptyLegacy(source, i) === "E")) {
        let exponentIndex = i + 1;
        if (exponentIndex < source.length && (charAtOrEmptyLegacy(source, exponentIndex) === "+" || charAtOrEmptyLegacy(source, exponentIndex) === "-")) {
          exponentIndex += 1;
        }
        if (exponentIndex < source.length && /[0-9]/.test(charAtOrEmptyLegacy(source, exponentIndex))) {
          i = exponentIndex + 1;
          while (i < source.length && /[0-9]/.test(charAtOrEmptyLegacy(source, i))) {
            i += 1;
          }
        }
      }
      if (i < source.length && (charAtOrEmptyLegacy(source, i) === "n" || charAtOrEmptyLegacy(source, i) === "N" || charAtOrEmptyLegacy(source, i) === "L")) {
        i += 1;
      }
      tokens.push({ type: "number", value: source.slice(start, i) });
      continue;
    }

    let matched = "";
    for (const symbol of MULTI_CHAR_SYMBOLS_LEGACY) {
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

function isWordLikeLegacy(token: FormatTokenLegacy | undefined): boolean {
  if (!token) {
    return false;
  }
  return token.type === "identifier" || token.type === "number" || token.type === "string" || token.type === "regexp" || token.type === "jsx";
}

function isMemberOperatorLegacy(token: FormatTokenLegacy | undefined): boolean {
  return token?.type === "symbol" && (token.value === "." || token.value === "?." || token.value === "!.");
}

function isUnaryPrefixLegacy(current: FormatTokenLegacy, previousSignificant: FormatTokenLegacy | undefined): boolean {
  if (current.type !== "symbol" || !UNARY_PREFIX_OPERATORS_LEGACY.has(current.value)) {
    return false;
  }

  if (!previousSignificant) {
    return true;
  }

  if (previousSignificant.type === "symbol") {
    const v = previousSignificant.value;
    if (
      v === "(" || v === "[" || v === "{" || v === "," || v === ";" || v === ":" ||
      BINARY_OPERATORS_LEGACY.has(v)
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

function isBinaryOperatorTokenLegacy(current: FormatTokenLegacy, previousSignificant: FormatTokenLegacy | undefined): boolean {
  if (current.type !== "symbol" || !BINARY_OPERATORS_LEGACY.has(current.value)) {
    return false;
  }
  return !isUnaryPrefixLegacy(current, previousSignificant);
}

function classifyTopLevelLineStartLegacy(token: FormatTokenLegacy): TopLevelLineKindLegacy {
  if (token.type === "commentLine" && token.value.startsWith("///")) {
    return "docComment";
  }
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

function shouldSpaceBeforeLegacy(
  previous: FormatTokenLegacy | undefined,
  current: FormatTokenLegacy,
  previousSignificant: FormatTokenLegacy | undefined,
  significantBeforePrevious: FormatTokenLegacy | undefined,
  nextToken: FormatTokenLegacy | undefined
): boolean {
  if (!previous) {
    return false;
  }

  if (isMemberOperatorLegacy(previous) || isMemberOperatorLegacy(current)) {
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
    if (previousSignificant?.type === "identifier" && VARIABLE_DECLARATION_KEYWORDS_LEGACY.has(previousSignificant.value)) return true;
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
      (previous.type === "identifier" && CONTROL_KEYWORDS_WITH_PAREN_LEGACY.has(previous.value)) ||
      (previous.type === "symbol" && isBinaryOperatorTokenLegacy(previous, significantBeforePrevious))
    );
  }

  if (isBinaryOperatorTokenLegacy(current, previousSignificant)) {
    return true;
  }

  if (previous.type === "symbol" && isBinaryOperatorTokenLegacy(previous, significantBeforePrevious)) {
    return true;
  }

  if (previous.type === "symbol" && isUnaryPrefixLegacy(previous, previousSignificant)) {
    return false;
  }

  if (isWordLikeLegacy(previous) && isWordLikeLegacy(current)) {
    return true;
  }

  return false;
}

// Detects whether the block opened by `{` at `openBraceIndex` is a brace lambda
// with an explicit parameter header (e.g. `{ resolve, reject -> ... }`). Returns
// the index of the header-terminating `->` token, or -1 when the block is not a
// parameter-headed lambda. Mirrors the parser's tail-lambda detection: the header
// must start with an identifier and reach a `->` at the brace's own nesting level.
function lambdaHeaderArrowIndexLegacy(tokens: FormatTokenLegacy[], openBraceIndex: number): number {
  let firstIndex = openBraceIndex + 1;
  while (firstIndex < tokens.length && tokens[firstIndex]?.type === "newline") {
    firstIndex += 1;
  }
  const firstToken = tokens[firstIndex];
  if (firstToken?.type !== "identifier" || STATEMENT_LEADING_KEYWORDS_LEGACY.has(firstToken.value)) {
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

function nextNonNewlineTokenLegacy(tokens: FormatTokenLegacy[], index: number): FormatTokenLegacy | undefined {
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

function previousNonTriviaTokenLegacy(tokens: FormatTokenLegacy[], index: number): FormatTokenLegacy | undefined {
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

function isFQNameStartTokenLegacy(token: FormatTokenLegacy | undefined): boolean {
  return !!token && token.type === "identifier";
}

function isFQNameContinuationTokenLegacy(token: FormatTokenLegacy | undefined, expectIdentifier: boolean): boolean {
  if (!token) {
    return false;
  }
  if (expectIdentifier) {
    return token.type === "identifier";
  }
  return token.type === "symbol" && token.value === ".";
}

function genericCloseCountLegacy(symbol: string, pendingGenericDepth: number): number {
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

function detectGenericAngleRolesLegacy(tokens: FormatTokenLegacy[]): GenericAngleClassificationLegacy {
  const emittedOverrides: Array<string | undefined> = new Array(tokens.length).fill(undefined);
  const roles: Array<GenericAngleRoleLegacy> = new Array(tokens.length).fill(undefined);
  const inside = new Array(tokens.length).fill(false);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.type !== "symbol" || token.value !== "<" || inside[index]) {
      continue;
    }

    const previous = previousNonTriviaTokenLegacy(tokens, index);
    const next = nextNonNewlineTokenLegacy(tokens, index);
    if (previous?.type !== "identifier" || !isFQNameStartTokenLegacy(next)) {
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
        const immediateCloseCount = current.type === "symbol" ? genericCloseCountLegacy(current.value, pendingGenericDepth) : 0;
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
        if (!isFQNameContinuationTokenLegacy(current, true)) {
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
          const nestedNext = nextNonNewlineTokenLegacy(tokens, cursor - 1);
          if (!isFQNameStartTokenLegacy(nestedNext)) {
            valid = false;
            break;
          }
          pendingGenericDepth += 1;
          roles[cursor - 1] = "open";
          expectIdentifier = true;
          continue;
      }
      const closeCount = current.type === "symbol" ? genericCloseCountLegacy(current.value, pendingGenericDepth) : 0;
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

    const tokenAfterSequence = endIndex >= 0 ? nextNonNewlineTokenLegacy(tokens, endIndex) : undefined;
    const hasTrailingSuffix = endIndex >= 0 && !!emittedOverrides[endIndex];
    if (!valid || pendingGenericDepth !== 0 || (!hasTrailingSuffix && isWordLikeLegacy(tokenAfterSequence))) {
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

interface CollectedImportStatementLegacy {
  stmt: FormatTokenLegacy[];
  hasSemicolon: boolean;
  endIndex: number;
}

function isImportStatementStartLegacy(tokens: FormatTokenLegacy[], index: number): boolean {
  const token = tokens[index];
  if (!token || token.type !== "identifier" || token.value !== "import") {
    return false;
  }
  const next = nextNonNewlineTokenLegacy(tokens, index);
  if (!next) {
    return false;
  }
  // `import.meta` and dynamic `import(...)` are expressions, not import statements.
  if (next.type === "symbol" && (next.value === "." || next.value === "(")) {
    return false;
  }
  return true;
}

function collectImportStatementLegacy(tokens: FormatTokenLegacy[], start: number): CollectedImportStatementLegacy | null {
  const stmt: FormatTokenLegacy[] = [];
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

function renderImportItemLegacy(itemTokens: FormatTokenLegacy[]): string {
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

function renderImportClauseOutsideLegacy(tokens: FormatTokenLegacy[]): string {
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

function splitImportNamedItemsLegacy(innerTokens: FormatTokenLegacy[]): FormatTokenLegacy[][] {
  const items: FormatTokenLegacy[][] = [];
  let current: FormatTokenLegacy[] = [];
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

function formatImportStatementTextLegacy(collected: CollectedImportStatementLegacy): string {
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
    const clause = renderImportClauseOutsideLegacy(clauseTokens);
    return `import ${typePrefix}${clause} from ${specifier.value}${semicolon}`;
  }

  const beforeBrace = clauseTokens.slice(0, braceOpen);
  const innerTokens = clauseTokens.slice(braceOpen + 1, braceClose);
  const afterBrace = clauseTokens.slice(braceClose + 1);
  const items = splitImportNamedItemsLegacy(innerTokens).map(renderImportItemLegacy);
  const beforeText = renderImportClauseOutsideLegacy(beforeBrace);
  const afterText = renderImportClauseOutsideLegacy(afterBrace);
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

interface FormattedImportBlockLegacy {
  text: string;
  count: number;
  endIndex: number;
}

function formatImportBlockLegacy(tokens: FormatTokenLegacy[], start: number): FormattedImportBlockLegacy | null {
  const lines: string[] = [];
  let cursor = start;
  while (cursor < tokens.length && isImportStatementStartLegacy(tokens, cursor)) {
    const collected = collectImportStatementLegacy(tokens, cursor);
    if (!collected) {
      break;
    }
    lines.push(formatImportStatementTextLegacy(collected));
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

export function formatSourceLegacy(source: string): string {
  const tokens = tokenizeForFormattingLegacy(source);
  const { emittedOverrides: genericEmittedOverrides, roles: genericAngleRoles, inside: genericInsideTokens } = detectGenericAngleRolesLegacy(tokens);

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

  let previousEmitted: FormatTokenLegacy | undefined;
  let previousSignificant: FormatTokenLegacy | undefined;
  let significantBeforePrevious: FormatTokenLegacy | undefined;
  let previousTopLevelLineKind: TopLevelLineKindLegacy | undefined;
  let currentTopLevelLineKind: TopLevelLineKindLegacy | undefined;

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

  const beginLineIfNeeded = (token: FormatTokenLegacy): void => {
    if (!atLineStart) {
      return;
    }

    if (indentLevel === 0) {
      const currentKind = classifyTopLevelLineStartLegacy(token);
      currentTopLevelLineKind = currentKind;
      if (
        previousTopLevelLineKind &&
        previousTopLevelLineKind !== "docComment" &&
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
      isImportStatementStartLegacy(tokens, index)
    ) {
      const block = formatImportBlockLegacy(tokens, index);
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
      const nextToken = nextNonNewlineTokenLegacy(tokens, index);
      if (previousEmitted && shouldSpaceBeforeLegacy(previousEmitted, token, previousSignificant, significantBeforePrevious, nextToken)) {
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
      const nextToken = nextNonNewlineTokenLegacy(tokens, index);
      if (previousEmitted && shouldSpaceBeforeLegacy(previousEmitted, token, previousSignificant, significantBeforePrevious, nextToken)) {
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

    const nextToken = nextNonNewlineTokenLegacy(tokens, index);
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
    if (previousEmitted && !suppressLeadingSpace && shouldSpaceBeforeLegacy(previousEmitted, token, previousSignificant, significantBeforePrevious, nextToken)) {
      result += " ";
    }

    if (genericEmittedOverrides[index]) {
      result += genericEmittedOverrides[index];
    } else if (genericRole === "splitClose" && token.type === "symbol") {
      result += ">".repeat(genericCloseCountLegacy(token.value, 3));
    } else {
      result += token.value;
    }
    if (token.type === "identifier" && VARIABLE_DECLARATION_KEYWORDS_LEGACY.has(token.value)) awaitingVariableBinding = true;
    if (token.type === "symbol" && token.value === "=") awaitingVariableBinding = false;
    previousEmitted = token;
    significantBeforePrevious = previousSignificant;
    previousSignificant = token;

    if (token.type === "symbol" && token.value === "->" && lambdaHeaderArrows.has(index)) {
      writeNewline();
      continue;
    }

    if (token.type === "symbol") {
      if (
        token.value === "{" &&
        (
          bindingBraceDepth > 0 ||
          (
            awaitingVariableBinding &&
            significantBeforePrevious?.type === "identifier" &&
            VARIABLE_DECLARATION_KEYWORDS_LEGACY.has(significantBeforePrevious.value)
          )
        )
      ) {
        bindingBraceDepth += 1;
        result += " ";
        continue;
      }
      if (token.value === "{") {
        indentLevel += 1;
        const arrowIndex = lambdaHeaderArrowIndexLegacy(tokens, index);
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

// === NEW AST-BASED FORMATTER ===

function ftok(node: Node): Token | undefined {
  return (node as unknown as { firstToken?: Token }).firstToken;
}
function ltok(node: Node): Token | undefined {
  return (node as unknown as { lastToken?: Token }).lastToken;
}
function accessorTok(member: ClassMethodMember): Token | undefined {
  return (member as unknown as { accessorToken?: Token }).accessorToken;
}

class AstFormatter {
  private out = "";
  private indentLvl = 0;
  private atLineStart = true;

  constructor(private readonly source: string) {}

  format(program: Program): string {
    this.emitTopLevel(program.body);
    return this.out.trimEnd();
  }

  // ── output primitives ──────────────────────────────────────────────

  private write(s: string): void { this.out += s; }

  private applyIndent(): void {
    if (this.atLineStart) {
      this.out += INDENT.repeat(this.indentLvl);
      this.atLineStart = false;
    }
  }

  private nl(): void {
    this.out = this.out.replace(/[ \t]+$/, "");
    if (!this.out.endsWith("\n")) this.out += "\n";
    this.atLineStart = true;
  }

  private blankLine(): void {
    this.nl();
    if (!this.out.endsWith("\n\n")) this.out += "\n";
  }

  private tok(s: string): void {
    this.applyIndent();
    this.write(s);
  }

  private sp(): void {
    if (!this.atLineStart) this.write(" ");
  }

  // ── source helpers ─────────────────────────────────────────────────

  private hasSemiAfter(node: Node): boolean {
    const lt = ltok(node);
    if (!lt) return false;
    let i = lt.range.end.offset;
    while (i < this.source.length && (this.source[i] === " " || this.source[i] === "\t")) i++;
    return this.source[i] === ";";
  }

  private srcSlice(a: Token, b: Token): string {
    return this.source.slice(a.range.start.offset, b.range.end.offset);
  }

  private strSrc(node: StringLiteral): string {
    const ft = ftok(node as Node);
    const lt = ltok(node as Node);
    if (ft && lt) return this.srcSlice(ft, lt);
    return `"${node.value}"`;
  }

  private blankLinesBefore(prev: Node, next: Node): number {
    const prevLine = ltok(prev)?.range.end.line ?? -1;
    const nextFt = ftok(next);
    const nextLine = nextFt?.leadingComments?.[0]?.range.start.line
      ?? nextFt?.range.start.line
      ?? -1;
    if (prevLine < 0 || nextLine < 0) return 0;
    return Math.max(0, nextLine - prevLine - 1);
  }

  // ── comment emission ───────────────────────────────────────────────

  private emitComments(tok: Token | undefined): void {
    if (!tok?.leadingComments?.length) return;
    for (const c of tok.leadingComments) {
      if (!this.atLineStart) this.nl();
      this.applyIndent();
      this.write(c.value);
      if (c.kind === "line") this.nl();
    }
  }

  // ── compound accessor detection ────────────────────────────────────

  private compoundAccessorKw(offset: number): string | undefined {
    const src = this.source;
    let i = offset - 1;
    while (i >= 0 && /[ \t\n\r]/.test(src[i]!)) i--;
    if (i < 0 || src[i] !== "{") return undefined;
    i--;
    while (i >= 0 && /[ \t\n\r]/.test(src[i]!)) i--;
    if (i < 0 || !/[A-Za-z0-9_]/.test(src[i]!)) return undefined;
    while (i >= 0 && /[A-Za-z0-9_]/.test(src[i]!)) i--;
    i--;
    while (i >= 0 && /[ \t\n\r]/.test(src[i]!)) i--;
    if (i < 0 || !/[a-z]/.test(src[i]!)) return undefined;
    const end = i + 1;
    while (i >= 0 && /[a-z]/.test(src[i]!)) i--;
    const kw = src.slice(i + 1, end);
    return ["var", "let", "val", "const"].includes(kw) ? kw : undefined;
  }

  // ── top-level statement grouping ───────────────────────────────────

  private topLevelKind(s: Statement): "fnOrClass" | "other" {
    switch (s.kind) {
      case "FunctionStatement": case "ClassStatement":
      case "InterfaceStatement": case "EnumStatement":
        return "fnOrClass";
      default:
        return "other";
    }
  }

  private emitTopLevel(stmts: Statement[]): void {
    let i = 0;
    let prev: Statement | null = null;

    while (i < stmts.length) {
      // Group consecutive imports
      if (stmts[i]!.kind === "ImportStatement") {
        const group: ImportStatement[] = [];
        while (i < stmts.length && stmts[i]!.kind === "ImportStatement") {
          group.push(stmts[i]! as ImportStatement);
          i++;
        }
        if (!this.atLineStart) this.nl();
        this.write(this.fmtImportBlock(group));
        this.nl();
        if (i < stmts.length && !this.out.endsWith("\n\n")) this.out += "\n";
        prev = group[group.length - 1]!;
        continue;
      }

      const stmt = stmts[i]!;

      if (prev !== null) {
        const pk = this.topLevelKind(prev);
        const ck = this.topLevelKind(stmt);
        if (pk === "fnOrClass" || ck === "fnOrClass") {
          if (!this.out.endsWith("\n\n")) {
            if (!this.out.endsWith("\n")) this.out += "\n";
            this.out += "\n";
          }
        } else {
          const blanks = this.blankLinesBefore(prev, stmt);
          if (blanks > 0) this.blankLine();
          else this.nl();
        }
      }

      this.emitStmt(stmt);
      prev = stmt;
      i++;
    }
  }

  // ── import formatting ──────────────────────────────────────────────

  private fmtImportBlock(imports: ImportStatement[]): string {
    return imports.map(imp => this.fmtImportLine(imp)).join("\n");
  }

  private fmtImportLine(imp: ImportStatement): string {
    const hasSemi = this.hasSemiAfter(imp as Node);
    const semi = hasSemi ? ";" : "";
    const specText = this.strSrc(imp.from);

    if (imp.sideEffectOnly) return `import ${specText}${semi}`;

    const typePrefix = imp.typeOnly ? "type " : "";
    const beforeNamed: string[] = [];
    if (imp.defaultImport) beforeNamed.push(imp.defaultImport.name);
    if (imp.namespaceImport) beforeNamed.push(`* as ${imp.namespaceImport.name}`);

    if (imp.specifiers.length === 0) {
      const clause = beforeNamed.join(", ");
      return `import ${typePrefix}${clause} from ${specText}${semi}`;
    }

    const specItems = imp.specifiers.map(s => {
      let txt = s.typeOnly && !imp.typeOnly ? `type ${s.imported.name}` : s.imported.name;
      if (s.local) txt += ` as ${s.local.name}`;
      return txt;
    });

    const namedBlock = specItems.length > 0 ? `{ ${specItems.join(", ")} }` : "{}";
    const beforeText = beforeNamed.length > 0 ? beforeNamed.join(", ") + ", " : "";
    const clause = `${beforeText}${namedBlock}`;
    const singleLine = `import ${typePrefix}${clause} from ${specText}${semi}`;

    if (singleLine.length <= IMPORT_PRINT_WIDTH) return singleLine;

    const prefix = `import ${typePrefix}${beforeText}{`;
    const suffix = `} from ${specText}${semi}`;
    const lines = [prefix];
    for (const item of specItems) lines.push(`${INDENT}${item},`);
    lines.push(suffix);
    return lines.join("\n");
  }

  // ── block statements ───────────────────────────────────────────────

  private emitBlock(block: BlockStatement): void {
    this.tok("{");
    this.nl();
    this.indentLvl++;
    this.emitBlockBody(block.body);
    this.indentLvl--;
    if (!this.atLineStart) this.nl();
    this.tok("}");
  }

  private emitBlockBody(stmts: Statement[]): void {
    let prev: Statement | null = null;
    for (const stmt of stmts) {
      if (prev !== null) {
        const blanks = this.blankLinesBefore(prev, stmt);
        if (blanks > 0 && !this.out.endsWith("\n\n")) this.out += "\n";
        else if (!this.atLineStart) this.nl();
      }
      this.emitComments(ftok(stmt as Node));
      this.emitStmt(stmt);
      if (!this.atLineStart) this.nl();
      prev = stmt;
    }
  }

  private emitBody(stmt: Statement): void {
    if (stmt.kind === "BlockStatement") {
      this.sp();
      this.emitBlock(stmt as BlockStatement);
    } else {
      this.emitComments(ftok(stmt as Node));
      this.emitStmt(stmt);
    }
  }

  // ── statement dispatch ─────────────────────────────────────────────

  private emitStmt(stmt: Statement): void {
    if (stmt.annotations?.length) {
      for (const ann of stmt.annotations) {
        this.emitAnnotationApp(ann);
        this.nl();
      }
    }
    this.emitComments(ftok(stmt as Node));

    switch (stmt.kind) {
      case "ImportStatement": this.emitImportStmt(stmt as ImportStatement); break;
      case "ExportStatement": this.emitExportStmt(stmt as ExportStatement); break;
      case "VarStatement": this.emitVarStmt(stmt as VarStatement); break;
      case "FunctionStatement": this.emitFunctionStmt(stmt as FunctionStatement); break;
      case "ClassStatement": this.emitClassStmt(stmt as ClassStatement); break;
      case "InterfaceStatement": this.emitInterfaceStmt(stmt as InterfaceStatement); break;
      case "TypeAliasStatement": this.emitTypeAliasStmt(stmt as TypeAliasStatement); break;
      case "NamespaceStatement": this.emitNamespaceStmt(stmt as NamespaceStatement); break;
      case "EnumStatement": this.emitEnumStmt(stmt as EnumStatement); break;
      case "BlockStatement": this.emitBlock(stmt as BlockStatement); break;
      case "IfStatement": this.emitIfStmt(stmt as IfStatement); break;
      case "ForStatement": this.emitForStmt(stmt as ForStatement); break;
      case "WhileStatement": this.emitWhileStmt(stmt as WhileStatement); break;
      case "DoWhileStatement": this.emitDoWhileStmt(stmt as DoWhileStatement); break;
      case "SwitchStatement": this.emitSwitchStmt(stmt as SwitchStatement); break;
      case "TryStatement": this.emitTryStmt(stmt as TryStatement); break;
      case "ReturnStatement": {
        const s = stmt as ReturnStatement;
        this.tok("return");
        if (s.expression) { this.sp(); this.emitExpr(s.expression); }
        this.emitTrailSemi(stmt);
        break;
      }
      case "ThrowStatement": {
        const s = stmt as ThrowStatement;
        this.tok("throw");
        this.sp();
        this.emitExpr(s.expression);
        this.emitTrailSemi(stmt);
        break;
      }
      case "BreakStatement": {
        const s = stmt as BreakStatement;
        this.tok("break");
        if (s.label) { this.sp(); this.tok(s.label.name); }
        this.emitTrailSemi(stmt);
        break;
      }
      case "ContinueStatement": {
        const s = stmt as ContinueStatement;
        this.tok("continue");
        if (s.label) { this.sp(); this.tok(s.label.name); }
        this.emitTrailSemi(stmt);
        break;
      }
      case "DeferStatement": {
        const s = stmt as DeferStatement;
        this.tok("defer");
        this.sp();
        this.emitExpr(s.expression);
        this.emitTrailSemi(stmt);
        break;
      }
      case "ExprStatement": {
        const s = stmt as ExprStatement;
        this.emitExpr(s.expression);
        this.emitTrailSemi(stmt);
        break;
      }
      case "LabeledStatement": {
        const s = stmt as LabeledStatement;
        this.tok(s.label.name);
        this.tok(":");
        this.sp();
        this.emitBody(s.body);
        break;
      }
      case "WithStatement": {
        const s = stmt as WithStatement;
        this.tok("with");
        this.sp();
        this.tok("(");
        this.emitExpr(s.object);
        this.tok(")");
        this.emitBody(s.body);
        break;
      }
      case "EmptyStatement": this.tok(";"); break;
      case "DebuggerStatement": this.tok("debugger"); this.emitTrailSemi(stmt); break;
      case "AnnotationStatement": this.emitAnnotationDecl(stmt as unknown as {
        declared?: boolean; name: Identifier; parameters: FunctionParameter[];
      }); break;
      default: break;
    }
  }

  private emitTrailSemi(stmt: Statement): void {
    if (this.hasSemiAfter(stmt as Node)) this.tok(";");
  }

  // ── specific statements ────────────────────────────────────────────

  private emitImportStmt(imp: ImportStatement): void {
    this.write(this.fmtImportLine(imp));
  }

  private emitExportStmt(stmt: ExportStatement): void {
    this.tok("export");
    if (stmt.typeOnly) { this.sp(); this.write("type"); }
    if (stmt.default) {
      this.sp(); this.write("default");
      if (stmt.declaration) { this.sp(); this.emitStmt(stmt.declaration); }
      else if (stmt.specifiers) {
        this.sp(); this.write("{");
        this.emitExportSpecifiers(stmt.specifiers);
        this.write("}");
      }
      this.emitTrailSemi(stmt);
      return;
    }
    if (stmt.exportAll) {
      this.sp(); this.write("*");
      if (stmt.namespaceExport) { this.sp(); this.write("as"); this.sp(); this.write(stmt.namespaceExport.name); }
      if (stmt.from) { this.sp(); this.write("from"); this.sp(); this.write(this.strSrc(stmt.from)); }
      this.emitTrailSemi(stmt);
      return;
    }
    if (stmt.specifiers) {
      this.sp(); this.write("{");
      this.emitExportSpecifiers(stmt.specifiers);
      this.write("}");
      if (stmt.from) { this.sp(); this.write("from"); this.sp(); this.write(this.strSrc(stmt.from)); }
      this.emitTrailSemi(stmt);
      return;
    }
    if (stmt.declaration) {
      this.sp();
      this.emitStmt(stmt.declaration);
      return;
    }
    this.emitTrailSemi(stmt);
  }

  private emitExportSpecifiers(specs: ExportSpecifier[]): void {
    if (specs.length === 0) return;
    this.write(" ");
    specs.forEach((s, i) => {
      if (i > 0) this.write(", ");
      if (s.typeOnly) this.write("type ");
      this.write(s.local?.name ?? s.exported.name);
      if (s.local && s.local.name !== s.exported.name) { this.write(" as "); this.write(s.exported.name); }
    });
    this.write(" ");
  }

  private emitVarStmt(stmt: VarStatement): void {
    if (stmt.declared) { this.tok("declare"); this.sp(); }
    this.tok(stmt.declarationKind);
    this.sp();
    if (stmt.receiverType) {
      this.emitTypeAnno(stmt.receiverType as Node);
      if (stmt.receiverTypeArguments?.length) {
        this.write("<");
        stmt.receiverTypeArguments.forEach((ta, i) => {
          if (i > 0) { this.write(","); this.sp(); }
          this.emitTypeAnno(ta as Node);
        });
        this.write(">");
      }
      this.write(".");
      this.emitBindingName(stmt.name);
      if (stmt.typeAnnotation) { this.write(":"); this.sp(); this.emitTypeAnno(stmt.typeAnnotation as Node); }
      if (stmt.accessors?.length) {
        this.sp();
        this.write("{");
        this.nl();
        this.indentLvl++;
        for (const accessor of stmt.accessors) {
          this.applyIndent();
          this.write(accessor.accessorKind ?? "get");
          if (accessor.accessorKind === "set" && accessor.parameters[0]) {
            this.write("(");
            this.emitFunctionParams(accessor.parameters);
            this.write(")");
          }
          this.sp();
          this.emitBlock(accessor.body);
          this.nl();
        }
        this.indentLvl--;
        this.applyIndent();
        this.write("}");
      } else if (stmt.initializer) {
        this.sp(); this.write("=>"); this.sp(); this.emitExpr(stmt.initializer);
      }
    } else if (stmt.declarations && stmt.declarations.length > 0) {
      stmt.declarations.forEach((d, i) => {
        if (i > 0) { this.write(","); this.sp(); }
        this.emitBindingName(d.name);
        if (d.typeAnnotation) { this.write(":"); this.sp(); this.emitTypeAnno(d.typeAnnotation as Node); }
        if (d.initializer) { this.sp(); this.write("="); this.sp(); this.emitExpr(d.initializer); }
      });
    } else {
      this.emitBindingName(stmt.name);
      if (stmt.typeAnnotation) { this.write(":"); this.sp(); this.emitTypeAnno(stmt.typeAnnotation as Node); }
      if (stmt.initializer) { this.sp(); this.write("="); this.sp(); this.emitExpr(stmt.initializer); }
    }
    this.emitTrailSemi(stmt);
  }

  private emitFunctionStmt(stmt: FunctionStatement): void {
    if (stmt.declared) { this.tok("declare"); this.sp(); }
    if (stmt.annotations?.length) { /* already emitted */ }
    if (stmt.async) { this.tok("async"); this.sp(); }
    if (stmt.sync) { this.tok("sync"); this.sp(); }
    this.tok(stmt.declarationKind);
    if (stmt.generator) this.write(" *");
    this.sp();
    if (stmt.receiverType) {
      this.emitTypeAnno(stmt.receiverType as Node);
      if (stmt.receiverTypeArguments?.length) {
        this.write("<");
        stmt.receiverTypeArguments.forEach((ta, i) => {
          if (i > 0) { this.write(","); this.sp(); }
          this.emitTypeAnno(ta as Node);
        });
        this.write(">");
      }
      this.write(".");
    }
    this.write(stmt.name.name);
    if (stmt.operator) this.write(stmt.operator);
    if (stmt.typeParameters?.length) this.emitTypeParams(stmt.typeParameters);
    this.write("(");
    this.emitFunctionParams(stmt.parameters);
    this.write(")");
    if (stmt.returnType) { this.write(":"); this.sp(); this.emitTypeAnno(stmt.returnType as Node); }
    if (stmt.missingBody) {
      this.emitTrailSemi(stmt);
      return;
    }
    this.sp();
    const bodyFt = ftok(stmt.body as Node);
    if (bodyFt?.value === "=>") {
      this.write("=>");
      this.sp();
      const ret = stmt.body.body[0];
      if (ret?.kind === "ReturnStatement") this.emitExpr((ret as ReturnStatement).expression!);
    } else {
      this.emitBlock(stmt.body);
    }
    this.emitTrailSemi(stmt);
  }

  private emitClassStmt(stmt: ClassStatement): void {
    if (stmt.declared) { this.tok("declare"); this.sp(); }
    if (stmt.abstract) { this.tok("abstract"); this.sp(); }
    this.tok("class");
    this.sp();
    this.write(stmt.name.name);
    if (stmt.typeParameters?.length) this.emitTypeParams(stmt.typeParameters);
    {
      const nameTok = ftok(stmt.name as Node);
      let pos = nameTok?.range.end.offset ?? 0;
      if (this.source[pos] === '<') {
        let depth = 1; pos++;
        while (pos < this.source.length && depth > 0) {
          if (this.source[pos] === '<') depth++;
          else if (this.source[pos] === '>') depth--;
          pos++;
        }
      }
      while (pos < this.source.length && (this.source[pos] === ' ' || this.source[pos] === '\t')) pos++;
      if (stmt.primaryConstructorParameters?.length) {
        this.write("(");
        stmt.primaryConstructorParameters.forEach((p, i) => {
          if (i > 0) { this.write(","); this.sp(); }
          this.emitPrimaryCtorParam(p);
        });
        this.write(")");
      } else if (this.source[pos] === '(') {
        this.write("()");
      }
    }
    if (stmt.extendsType) { this.sp(); this.write("extends"); this.sp(); this.emitTypeAnno(stmt.extendsType as Node); }
    if (stmt.implementsTypes?.length) {
      this.sp(); this.write("implements"); this.sp();
      stmt.implementsTypes.forEach((t, i) => {
        if (i > 0) { this.write(","); this.sp(); }
        this.emitTypeAnno(t as Node);
      });
    }
    if (!stmt.members.length && !this.hasBraceInSource(stmt)) {
      return;
    }
    this.sp();
    this.tok("{");
    this.nl();
    this.indentLvl++;
    this.emitClassMembers(stmt.members);
    this.indentLvl--;
    if (!this.atLineStart) this.nl();
    this.tok("}");
  }

  private emitClassExpr(expr: ClassExpression): void {
    if (expr.abstract) { this.tok("abstract"); this.sp(); }
    this.tok("class");
    if (expr.name) {
      this.sp();
      this.write(expr.name.name);
    }
    if (expr.typeParameters?.length) this.emitTypeParams(expr.typeParameters);
    if (expr.extendsType) { this.sp(); this.write("extends"); this.sp(); this.emitTypeAnno(expr.extendsType as Node); }
    if (expr.implementsTypes?.length) {
      this.sp(); this.write("implements"); this.sp();
      expr.implementsTypes.forEach((t, i) => {
        if (i > 0) { this.write(","); this.sp(); }
        this.emitTypeAnno(t as Node);
      });
    }
    this.sp();
    this.tok("{");
    this.nl();
    this.indentLvl++;
    this.emitClassMembers(expr.members);
    this.indentLvl--;
    if (!this.atLineStart) this.nl();
    this.tok("}");
  }

  private hasBraceInSource(stmt: ClassStatement | InterfaceStatement): boolean {
    const lt = ltok(stmt as Node);
    if (!lt) return false;
    return lt.value === "}";
  }

  private emitPrimaryCtorParam(p: ClassPrimaryConstructorParameter): void {
    this.write(p.declarationKind);
    this.sp();
    this.write(p.name.name);
    if (p.typeAnnotation) { this.write(":"); this.sp(); this.emitTypeAnno(p.typeAnnotation as Node); }
    if (p.defaultValue) { this.sp(); this.write("="); this.sp(); this.emitExpr(p.defaultValue); }
  }

  private emitClassMembers(members: (ClassFieldMember | ClassMethodMember)[]): void {
    let i = 0;
    while (i < members.length) {
      const member = members[i]!;
      this.emitComments(ftok(member as Node));

      if (member.kind === "ClassMethodMember" && member.accessorKind) {
        // Check for compound accessor block
        const at = accessorTok(member);
        const kw = at ? this.compoundAccessorKw(at.range.start.offset) : undefined;
        if (kw !== undefined) {
          // Collect all members in this compound block (same name, accessor kinds)
          const name = member.name.name;
          const compoundMembers: ClassMethodMember[] = [];
          while (i < members.length) {
            const m = members[i]!;
            if (m.kind === "ClassMethodMember" && m.accessorKind && m.name.name === name) {
              compoundMembers.push(m as ClassMethodMember);
              i++;
            } else break;
          }
          this.emitCompoundAccessors(kw, name, compoundMembers);
          this.nl();
          continue;
        }
      }

      this.emitClassMember(member);
      const hasSemi = this.hasSemiAfter(member as Node);
      if (hasSemi) this.tok(";");
      this.nl();
      i++;
    }
  }

  private emitCompoundAccessors(kw: string, name: string, members: ClassMethodMember[]): void {
    this.tok(kw); this.sp(); this.write(name); this.sp(); this.tok("{");
    this.nl();
    this.indentLvl++;
    for (const m of members) {
      this.emitComments(ftok(m as Node));
      this.tok(m.accessorKind!);
      this.sp();
      const bodyFt = ftok(m.body as Node);
      if (bodyFt?.value === "=>") {
        this.write("=>");
        this.sp();
        const ret = m.body.body[0];
        if (ret?.kind === "ReturnStatement") this.emitExpr((ret as ReturnStatement).expression!);
        this.nl();
      } else {
        this.emitBlock(m.body);
        this.nl();
      }
    }
    this.indentLvl--;
    this.tok("}");
  }

  private emitClassMember(member: ClassFieldMember | ClassMethodMember): void {
    if (member.annotations?.length) {
      for (const ann of member.annotations) {
        this.emitAnnotationApp(ann);
        this.nl();
      }
    }
    this.applyIndent();
    if (member.kind === "ClassFieldMember") {
      const m = member as ClassFieldMember;
      if (m.declared) { this.tok("declare"); this.sp(); }
      if (m.accessModifier) { this.tok(m.accessModifier); this.sp(); }
      if (m.static) { this.tok("static"); this.sp(); }
      if (m.abstract) { this.tok("abstract"); this.sp(); }
      if (m.readonly && m.declarationKind !== "val" && m.declarationKind !== "const") {
        this.tok("readonly"); this.sp();
      }
      if (m.declarationKind) { this.tok(m.declarationKind); this.sp(); }
      if (m.computed && m.computedKey) {
        this.write("[");
        this.emitExpr(m.computedKey);
        this.write("]");
      } else {
        this.write(m.name.name);
      }
      if (m.optional) this.write("?");
      if (m.definiteAssignment) this.write("!");
      if (m.typeAnnotation) { this.write(":"); this.sp(); this.emitTypeAnno(m.typeAnnotation as Node); }
      if (m.initializer) { this.sp(); this.write("="); this.sp(); this.emitExpr(m.initializer); }
    } else {
      const m = member as ClassMethodMember;
      if (m.accessModifier) { this.tok(m.accessModifier); this.sp(); }
      if (m.static) { this.tok("static"); this.sp(); }
      if (m.abstract) { this.tok("abstract"); this.sp(); }
      if (m.async) { this.tok("async"); this.sp(); }
      if (m.sync) { this.tok("sync"); this.sp(); }
      if (m.declarationKind) { this.tok(m.declarationKind); this.sp(); }
      if (m.readonly && !m.declarationKind) { this.tok("readonly"); this.sp(); }
      const at = accessorTok(m);
      if (m.accessorKind && at) {
        this.tok(m.accessorKind);
        this.sp();
      }
      if (m.generator) this.write("*");
      if (m.computed && m.computedKey) {
        this.write("[");
        this.emitExpr(m.computedKey);
        this.write("]");
      } else {
        this.write(m.name.name.startsWith("operator") ? m.name.name : m.name.name);
      }
      if (m.typeParameters?.length) this.emitTypeParams(m.typeParameters);
      if (m.computed || m.name.name !== "operator" || !m.operator) {
        this.write("(");
        this.emitFunctionParams(m.parameters);
        this.write(")");
      } else {
        this.write(m.operator);
        this.write("(");
        this.emitFunctionParams(m.parameters);
        this.write(")");
      }
      if (m.returnType) { this.write(":"); this.sp(); this.emitTypeAnno(m.returnType as Node); }
      if (m.missingBody) return;
      this.sp();
      const bodyFt = ftok(m.body as Node);
      if (bodyFt?.value === "=>") {
        this.write("=>");
        this.sp();
        const ret = m.body.body[0];
        if (ret?.kind === "ReturnStatement") this.emitExpr((ret as ReturnStatement).expression!);
      } else {
        this.emitBlock(m.body);
      }
    }
  }

  private emitInterfaceStmt(stmt: InterfaceStatement): void {
    if (stmt.declared) { this.tok("declare"); this.sp(); }
    this.tok("interface"); this.sp(); this.write(stmt.name.name);
    if (stmt.typeParameters?.length) this.emitTypeParams(stmt.typeParameters);
    if (stmt.extendsTypes?.length) {
      this.sp(); this.write("extends"); this.sp();
      stmt.extendsTypes.forEach((t, i) => {
        if (i > 0) { this.write(","); this.sp(); }
        this.emitTypeAnno(t as Node);
      });
    }
    if (!stmt.members.length && !this.hasBraceInSource(stmt)) {
      return;
    }
    this.sp(); this.tok("{");
    this.nl();
    this.indentLvl++;
    for (const m of stmt.members) {
      this.emitComments(ftok(m as Node));
      if (m.kind === "InterfacePropertyMember") {
        if (m.declarationKind) { this.tok(m.declarationKind); this.sp(); }
        this.write(m.name.name);
        if (m.optional) this.write("?");
        this.write(":"); this.sp();
        this.emitTypeAnno(m.typeAnnotation as Node);
      } else {
        if (m.declarationKind) { this.tok(m.declarationKind); this.sp(); }
        if (m.accessorKind) { this.write(m.accessorKind); this.sp(); }
        if (m.computed && m.computedKey) {
          this.write("[");
          this.emitExpr(m.computedKey);
          this.write("]");
        } else {
          this.write(m.name.name);
        }
        if (m.typeParameters?.length) this.emitTypeParams(m.typeParameters);
        this.write("(");
        this.emitFunctionParams(m.parameters);
        this.write(")");
        if (m.returnType) { this.write(":"); this.sp(); this.emitTypeAnno(m.returnType as Node); }
      }
      if (this.hasSemiAfter(m as Node)) this.tok(";");
      this.nl();
    }
    this.indentLvl--;
    if (!this.atLineStart) this.nl();
    this.tok("}");
    this.emitTrailSemi(stmt);
  }

  private emitTypeAliasStmt(stmt: TypeAliasStatement): void {
    if (stmt.declared) { this.tok("declare"); this.sp(); }
    this.tok("type"); this.sp(); this.write(stmt.name.name);
    if (stmt.typeParameters?.length) this.emitTypeParams(stmt.typeParameters);
    this.sp(); this.write("="); this.sp();
    this.emitTypeAnno(stmt.targetType as Node);
    this.emitTrailSemi(stmt);
  }

  private emitNamespaceStmt(stmt: NamespaceStatement): void {
    if (stmt.declared) { this.tok("declare"); this.sp(); }
    this.tok(stmt.declarationKind);
    this.sp();
    if (stmt.names?.length) {
      stmt.names.forEach((n, i) => {
        if (i > 0) this.write(".");
        this.write(n.name);
      });
    }
    if (stmt.externalModuleName) {
      this.write(this.strSrc(stmt.externalModuleName));
    }
    this.sp();
    this.emitBlock(stmt.body);
  }

  private emitEnumStmt(stmt: EnumStatement): void {
    if (stmt.declared) { this.tok("declare"); this.sp(); }
    if (stmt.const) { this.tok("const"); this.sp(); }
    this.tok("enum"); this.sp(); this.write(stmt.name.name);
    this.sp(); this.tok("{");
    this.nl();
    this.indentLvl++;
    if (stmt.members.length > 0) {
      this.tok("");
      stmt.members.forEach((m, i) => {
        this.emitComments(ftok(m as Node));
        this.write(m.name.name);
        if (m.initializer) { this.sp(); this.write("="); this.sp(); this.emitExpr(m.initializer); }
        if (i < stmt.members.length - 1) { this.write(","); this.sp(); }
      });
      this.nl();
    }
    this.indentLvl--;
    this.tok("}");
  }

  private emitIfStmt(stmt: IfStatement): void {
    this.tok("if"); this.sp();
    this.tok("("); this.emitExpr(stmt.condition); this.tok(")");
    if (stmt.thenBranch.kind === "BlockStatement") {
      this.sp();
      this.emitBlock(stmt.thenBranch as BlockStatement);
      if (stmt.elseBranch) {
        this.write(" else ");
        if (stmt.elseBranch.kind === "BlockStatement") {
          this.emitBlock(stmt.elseBranch as BlockStatement);
        } else if (stmt.elseBranch.kind === "IfStatement") {
          this.emitIfStmt(stmt.elseBranch as IfStatement);
        } else {
          this.emitStmt(stmt.elseBranch);
        }
      }
    } else {
      this.emitBody(stmt.thenBranch);
      if (stmt.elseBranch) {
        this.nl();
        this.tok("else");
        this.emitBody(stmt.elseBranch);
      }
    }
  }

  private emitForStmt(stmt: ForStatement): void {
    this.tok("for");
    if (stmt.await) { this.sp(); this.write("await"); }
    this.sp(); this.tok("(");
    if (stmt.iterationKind) {
      if (stmt.iterator) {
        if ((stmt.iterator as Node).kind === "VarStatement") {
          this.emitVarStmtNoSemi(stmt.iterator as VarStatement);
        } else {
          this.emitExpr(stmt.iterator as Expr);
        }
      }
      this.sp(); this.write(stmt.iterationKind); this.sp();
      if (stmt.iterable) this.emitExpr(stmt.iterable);
    } else {
      if (stmt.initializer) {
        if ((stmt.initializer as Node).kind === "VarStatement") {
          this.emitVarStmtNoSemi(stmt.initializer as VarStatement);
        } else {
          this.emitExpr(stmt.initializer as Expr);
        }
      }
      this.write(";"); this.sp();
      if (stmt.condition) this.emitExpr(stmt.condition);
      this.write(";"); this.sp();
      if (stmt.update) this.emitExpr(stmt.update);
    }
    this.tok(")");
    this.emitBody(stmt.body);
  }

  private emitVarStmtNoSemi(stmt: VarStatement): void {
    this.tok(stmt.declarationKind); this.sp();
    this.emitBindingName(stmt.name);
    if (stmt.typeAnnotation) { this.write(":"); this.sp(); this.emitTypeAnno(stmt.typeAnnotation as Node); }
    if (stmt.initializer) { this.sp(); this.write("="); this.sp(); this.emitExpr(stmt.initializer); }
  }

  private emitWhileStmt(stmt: WhileStatement): void {
    this.tok("while"); this.sp();
    this.tok("("); this.emitExpr(stmt.condition); this.tok(")");
    this.emitBody(stmt.body);
  }

  private emitDoWhileStmt(stmt: DoWhileStatement): void {
    this.tok("do");
    this.emitBody(stmt.body);
    this.sp(); this.write("while"); this.sp();
    this.write("("); this.emitExpr(stmt.condition); this.write(")");
    this.emitTrailSemi(stmt);
  }

  private emitSwitchStmt(stmt: SwitchStatement): void {
    this.tok("switch"); this.sp();
    this.tok("("); this.emitExpr(stmt.discriminant); this.tok(")");
    this.sp(); this.tok("{");
    this.nl();
    this.indentLvl++;
    for (const c of stmt.cases) {
      this.emitComments(ftok(c as Node));
      if (c.test) {
        this.tok("case"); this.sp(); this.emitExpr(c.test); this.write(":");
      } else {
        this.tok("default:");
      }
      if (c.consequent.length > 0) {
        this.write(" ");
        const first = c.consequent[0]!;
        this.emitComments(ftok(first as Node));
        this.emitStmt(first);
        if (!this.atLineStart) this.nl();
        for (let i = 1; i < c.consequent.length; i++) {
          const s = c.consequent[i]!;
          this.emitComments(ftok(s as Node));
          this.emitStmt(s);
          if (!this.atLineStart) this.nl();
        }
      } else {
        this.nl();
      }
    }
    this.indentLvl--;
    this.tok("}");
  }

  private emitTryStmt(stmt: TryStatement): void {
    this.tok("try");
    this.sp();
    this.emitBlock(stmt.tryBlock);
    if (stmt.catchClause) {
      this.nl();
      this.tok("catch");
      if (stmt.catchClause.parameter) {
        this.sp(); this.write("("); this.write(stmt.catchClause.parameter.name); this.write(")");
      }
      this.sp();
      this.emitBlock(stmt.catchClause.body);
    }
    if (stmt.finallyBlock) {
      this.nl();
      this.tok("finally");
      this.sp();
      this.emitBlock(stmt.finallyBlock);
    }
  }

  private emitAnnotationApp(ann: AnnotationApplication): void {
    this.tok(`@${ann.name.name}`);
    if (ann.arguments.length > 0) {
      this.write("(");
      this.emitArgList(ann.arguments);
      this.write(")");
    }
  }

  private emitAnnotationDecl(stmt: { declared?: boolean; name: Identifier; parameters: FunctionParameter[] }): void {
    if (stmt.declared) { this.tok("declare"); this.sp(); }
    this.tok("annotation"); this.sp(); this.write(stmt.name.name);
    this.write("("); this.emitFunctionParams(stmt.parameters); this.write(")");
  }

  // ── type annotations ───────────────────────────────────────────────

  private emitTypeAnno(node: Node): void {
    const kind = (node as { kind?: string }).kind;
    if (kind === "TypeReference") {
      const tr = node as unknown as TypeReference;
      this.write(tr.name.name);
      if (tr.typeArguments?.length) {
        this.write("<");
        tr.typeArguments.forEach((ta, i) => {
          if (i > 0) { this.write(","); this.sp(); }
          this.emitTypeAnno(ta as unknown as Node);
        });
        this.write(">");
      }
    } else if (kind === "ArrayTypeAnnotation") {
      const at = node as unknown as ArrayTypeAnnotation;
      this.emitTypeAnno(at.elementType as unknown as Node);
      this.write("[]");
    } else {
      // Identifier
      const id = node as unknown as Identifier;
      this.write(id.name);
    }
  }

  // ── type parameters ────────────────────────────────────────────────

  private emitTypeParams(tps: TypeParameter[]): void {
    this.write("<");
    tps.forEach((tp, i) => {
      if (i > 0) { this.write(","); this.sp(); }
      this.write(tp.name.name);
      if (tp.constraint) { this.sp(); this.write(":"); this.sp(); this.write(tp.constraint.name); }
    });
    this.write(">");
  }

  // ── function parameters ────────────────────────────────────────────

  private emitFunctionParams(params: FunctionParameter[]): void {
    params.forEach((p, i) => {
      if (i > 0) { this.write(","); this.sp(); }
      this.emitFunctionParam(p);
    });
  }

  private emitFunctionParam(p: FunctionParameter): void {
    if (p.thisParameter) { this.write("this"); return; }
    if (p.accessModifier) { this.write(p.accessModifier); this.sp(); }
    if (p.readonly) { this.write("readonly"); this.sp(); }
    if (p.rest) this.write("...");
    this.emitBindingName(p.name);
    if (p.optional) this.write("?");
    if (p.typeAnnotation) { this.write(":"); this.sp(); this.emitTypeAnno(p.typeAnnotation as Node); }
    if (p.defaultValue) { this.sp(); this.write("="); this.sp(); this.emitExpr(p.defaultValue); }
  }

  // ── binding names ──────────────────────────────────────────────────

  private emitBindingName(name: BindingName): void {
    const kind = (name as Node).kind;
    if (kind === "ObjectBindingPattern") {
      const obp = name as ObjectBindingPattern;
      this.write("{ ");
      obp.elements.forEach((el, i) => {
        if (i > 0) { this.write(","); this.sp(); }
        this.emitBindingElement(el as BindingElement);
      });
      this.write(" }");
    } else if (kind === "ArrayBindingPattern") {
      const abp = name as ArrayBindingPattern;
      this.write("[");
      abp.elements.forEach((el, i) => {
        if (i > 0) { this.write(","); this.sp(); }
        if ((el as Node).kind === "BindingHole") {
          // emit nothing for hole
        } else {
          this.emitBindingElement(el as BindingElement);
        }
      });
      this.write("]");
    } else {
      this.write((name as Identifier).name);
    }
  }

  private emitBindingElement(el: BindingElement): void {
    if (el.rest) this.write("...");
    if (el.propertyName && !el.shorthand) {
      this.write(el.propertyName.kind === "Identifier" ? el.propertyName.name : JSON.stringify(el.propertyName.value));
      this.write(":");
      this.sp();
    }
    this.emitBindingName(el.name);
    if (el.typeAnnotation) { this.write(":"); this.sp(); this.emitTypeAnno(el.typeAnnotation as Node); }
    if (el.initializer) { this.sp(); this.write("="); this.sp(); this.emitExpr(el.initializer); }
  }

  // ── expressions ────────────────────────────────────────────────────

  private emitExpr(expr: Expr): void {
    this.applyIndent();
    this.emitComments(ftok(expr as Node));
    const ft = ftok(expr as Node);
    const lt = ltok(expr as Node);
    // Template literal: backtick immediately before firstToken AND closing backtick at lastToken end
    if (ft && ft.range.start.offset > 0 && this.source[ft.range.start.offset - 1] === '`'
      && lt && this.source[lt.range.end.offset] === '`') {
      this.write(this.source.slice(ft.range.start.offset - 1, lt.range.end.offset + 1));
      return;
    }
    // Explicit grouping parentheses
    if (ft && ft.range.start.offset > 0 && this.source[ft.range.start.offset - 1] === '('
      && lt && this.source[lt.range.end.offset] === ')'
      && !this.out.endsWith('(')) {
      this.write('(');
      this.emitExprSwitch(expr);
      this.write(')');
      return;
    }
    this.emitExprSwitch(expr);
  }

  private emitExprSwitch(expr: Expr): void {
    const kind = (expr as Node).kind;
    switch (kind) {
      case "IntLiteral": case "FloatLiteral":
        this.write(ftok(expr as Node)?.value ?? String((expr as IntLiteral).value));
        break;
      case "BigIntLiteral":
        this.write(ftok(expr as Node)?.value ?? `${(expr as BigIntLiteral).value}n`);
        break;
      case "LongLiteral":
        this.write(ftok(expr as Node)?.value ?? `${(expr as LongLiteral).value}L`);
        break;
      case "BooleanLiteral":
        this.write(String((expr as BooleanLiteral).value));
        break;
      case "NullLiteral": this.write("null"); break;
      case "UndefinedLiteral": this.write("undefined"); break;
      case "StringLiteral":
        this.write(this.strSrc(expr as StringLiteral));
        break;
      case "RegExpLiteral": {
        const re = expr as RegExpLiteral;
        const rft = ftok(re as Node);
        const rlt = ltok(re as Node);
        this.write(rft && rlt ? this.srcSlice(rft, rlt) : `/${re.pattern}/${re.flags}`);
        break;
      }
      case "Identifier":
        this.write((expr as Identifier).name);
        break;
      case "MissingExpression": break;
      case "ArrayHole": break;
      case "BinaryExpression": this.emitBinaryExpr(expr as BinaryExpression); break;
      case "ChainExpression": this.emitChainExpr(expr as ChainExpression); break;
      case "AssignmentExpression": this.emitAssignExpr(expr as AssignmentExpression); break;
      case "RangeExpression": this.emitRangeExpr(expr as RangeExpression); break;
      case "UnaryExpression": this.emitUnaryExpr(expr as UnaryExpression); break;
      case "UpdateExpression": this.emitUpdateExpr(expr as UpdateExpression); break;
      case "CallExpression": this.emitCallExpr(expr as CallExpression); break;
      case "MemberExpression": this.emitMemberExpr(expr as MemberExpression); break;
      case "NewExpression": this.emitNewExpr(expr as NewExpression); break;
      case "ConditionalExpression": this.emitCondExpr(expr as ConditionalExpression); break;
      case "ArrowFunctionExpression": this.emitArrowFnExpr(expr as ArrowFunctionExpression); break;
      case "FunctionExpression": this.emitFunctionExpr(expr as FunctionExpression); break;
      case "ClassExpression": this.emitClassExpr(expr as ClassExpression); break;
      case "ArrayLiteral": this.emitArrayLiteral(expr as ArrayLiteral); break;
      case "ObjectLiteral": this.emitObjectLiteral(expr as ObjectLiteral); break;
      case "SpreadExpression": {
        const s = expr as SpreadExpression;
        this.write("..."); this.emitExpr(s.argument);
        break;
      }
      case "AsExpression": {
        const a = expr as AsExpression;
        this.emitExpr(a.expression); this.sp(); this.write("as"); this.sp(); this.write(a.typeAnnotation.name);
        break;
      }
      case "SatisfiesExpression": {
        const s = expr as SatisfiesExpression;
        this.emitExpr(s.expression); this.sp(); this.write("satisfies"); this.sp(); this.write(s.typeAnnotation.name);
        break;
      }
      case "NonNullExpression": {
        const n = expr as NonNullExpression;
        this.emitExpr(n.expression); this.write("!");
        break;
      }
      case "CommaExpression": {
        const c = expr as CommaExpression;
        c.expressions.forEach((e, i) => {
          if (i > 0) { this.write(","); this.sp(); }
          this.emitExpr(e);
        });
        break;
      }
      case "NamedArgument": {
        const na = expr as NamedArgument;
        this.write(na.name.name); this.write(":"); this.sp(); this.emitExpr(na.value);
        break;
      }
      case "JsxElement": {
        const jx = expr as JsxElement;
        const jft = ftok(jx as Node);
        const jlt = ltok(jx as Node);
        if (jft && jlt) this.write(this.srcSlice(jft, jlt));
        break;
      }
      case "JsxFragment": {
        const jf = expr as JsxFragment;
        const jft = ftok(jf as Node);
        const jlt = ltok(jf as Node);
        if (jft && jlt) this.write(this.srcSlice(jft, jlt));
        break;
      }
      default: break;
    }
  }

  private emitBinaryExpr(expr: BinaryExpression): void {
    this.emitExpr(expr.left);
    this.sp(); this.write(expr.operator); this.sp();
    this.emitExpr(expr.right);
  }

  private emitAssignExpr(expr: AssignmentExpression): void {
    this.emitExpr(expr.left);
    this.sp(); this.write(expr.operator); this.sp();
    this.emitExpr(expr.right);
  }

  private emitRangeExpr(expr: RangeExpression): void {
    this.emitExpr(expr.start);
    this.sp(); this.write(expr.exclusive ? "..<" : "..."); this.sp();
    this.emitExpr(expr.end);
  }

  private emitChainExpr(expr: ChainExpression): void {
    this.emitExpr(expr.receiver);
    expr.operations.forEach((operation) => {
      this.nl();
      this.indentLvl++;
      this.applyIndent();
      this.tok("..");
      this.emitChainOperation(operation);
      this.indentLvl--;
    });
  }

  private emitChainOperation(operation: Expr): void {
    if ((operation as Node).kind === "AssignmentExpression") {
      const assignment = operation as AssignmentExpression;
      this.emitChainOperation(assignment.left);
      this.sp(); this.write(assignment.operator); this.sp();
      this.emitExpr(assignment.right);
      return;
    }
    if ((operation as Node).kind === "CallExpression") {
      const call = operation as CallExpression;
      this.emitChainOperation(call.callee);
      this.write("("); this.emitArgList(call.arguments); this.write(")");
      return;
    }
    if ((operation as Node).kind === "MemberExpression") {
      const member = operation as MemberExpression;
      if (!member.computed && member.property.kind === "Identifier") {
        this.emitExpr(member.property);
        return;
      }
    }
    this.emitExpr(operation);
  }

  private emitUnaryExpr(expr: UnaryExpression): void {
    const op = expr.operator;
    if (op === "typeof" || op === "void" || op === "delete" || op === "await"
      || op === "yield" || op === "yield*" || op === "go") {
      this.write(op === "yield*" ? "yield*" : op);
      this.sp();
      this.emitExpr(expr.argument);
    } else {
      this.write(op);
      this.emitExpr(expr.argument);
    }
  }

  private emitUpdateExpr(expr: UpdateExpression): void {
    if (expr.prefix) {
      this.write(expr.operator);
      this.emitExpr(expr.argument);
    } else {
      this.emitExpr(expr.argument);
      this.write(expr.operator);
    }
  }

  private emitCallExpr(expr: CallExpression): void {
    const lastArg = expr.arguments[expr.arguments.length - 1];
    const isBraceLambda = lastArg &&
      (lastArg as Node).kind === "ArrowFunctionExpression" &&
      ftok(lastArg as Node)?.value === "{";

    if (isBraceLambda) {
      const lambda = lastArg as ArrowFunctionExpression;
      const otherArgs = expr.arguments.slice(0, -1);
      this.emitExpr(expr.callee);
      if (otherArgs.length > 0) {
        if (expr.typeArguments?.length) this.emitCallTypeArgs(expr.typeArguments as unknown as Node[]);
        this.write("("); this.emitArgList(otherArgs); this.write(")");
      }
      this.sp();
      this.emitBraceLambda(lambda);
    } else {
      this.emitExpr(expr.callee);
      if (expr.typeArguments?.length) this.emitCallTypeArgs(expr.typeArguments as unknown as Node[]);
      this.write("("); this.emitArgList(expr.arguments); this.write(")");
    }
  }

  private emitCallTypeArgs(typeArgs: Node[]): void {
    this.write("<");
    typeArgs.forEach((ta, i) => {
      if (i > 0) { this.write(","); this.sp(); }
      this.emitTypeAnno(ta);
    });
    this.write(">");
  }

  private emitArgList(args: Expr[]): void {
    args.forEach((a, i) => {
      if (i > 0) { this.write(","); this.sp(); }
      this.emitExpr(a);
    });
  }

  private emitBraceLambda(lambda: ArrowFunctionExpression): void {
    const ft = ftok(lambda as Node);
    const hasExplicitParams = lambda.parameters.length > 0 &&
      ftok(lambda.parameters[0]! as Node)?.range.start.offset !== ft?.range.start.offset;

    this.tok("{");
    if (hasExplicitParams) {
      this.write(" ");
      lambda.parameters.forEach((p, i) => {
        if (i > 0) this.write(", ");
        this.emitBindingName(p.name);
      });
      this.write(" ->");
      this.nl();
      this.indentLvl++;
      if ((lambda.body as Node).kind === "BlockStatement") {
        this.emitBlockBody((lambda.body as BlockStatement).body);
      } else {
        this.emitComments(ftok(lambda.body as Node));
        this.emitExpr(lambda.body as Expr);
        if (!this.atLineStart) this.nl();
      }
      this.indentLvl--;
      this.tok("}");
    } else {
      this.nl();
      this.indentLvl++;
      if ((lambda.body as Node).kind === "BlockStatement") {
        this.emitBlockBody((lambda.body as BlockStatement).body);
      } else {
        this.emitComments(ftok(lambda.body as Node));
        this.tok("");
        this.emitExpr(lambda.body as Expr);
        if (!this.atLineStart) this.nl();
      }
      this.indentLvl--;
      this.tok("}");
    }
  }

  private emitMemberExpr(expr: MemberExpression): void {
    this.emitExpr(expr.object);
    if (expr.computed) {
      if (expr.optional) this.write("?.");
      else if (expr.nonNullAsserted) this.write("!.");
      this.write("["); this.emitExpr(expr.property); this.write("]");
    } else {
      if (expr.optional) this.write("?.");
      else if (expr.nonNullAsserted) this.write("!.");
      else this.write(".");
      this.emitExpr(expr.property);
    }
  }

  private emitNewExpr(expr: NewExpression): void {
    this.tok("new"); this.sp();
    this.emitExpr(expr.callee);
    if (expr.typeArguments?.length) {
      this.write("<");
      expr.typeArguments.forEach((ta, i) => {
        if (i > 0) { this.write(","); this.sp(); }
        this.emitTypeAnno(ta as unknown as Node);
      });
      this.write(">");
    }
    if (expr.arguments !== undefined) {
      const args = expr.arguments;
      if (args.length === 1 && (args[0] as Node).kind === "ArrowFunctionExpression"
        && ftok(args[0] as Node)?.value === "{") {
        this.sp();
        this.emitExpr(args[0] as Expr);
      } else {
        this.write("("); this.emitArgList(args); this.write(")");
      }
    }
  }

  private emitCondExpr(expr: ConditionalExpression): void {
    this.emitExpr(expr.test);
    this.sp(); this.write("?"); this.sp();
    this.emitExpr(expr.consequent);
    this.sp(); this.write(":"); this.sp();
    this.emitExpr(expr.alternate);
  }

  private emitArrowFnExpr(expr: ArrowFunctionExpression): void {
    if (expr.async) { this.write("async"); this.sp(); }
    if (expr.sync) { this.write("sync"); this.sp(); }
    const ft = ftok(expr as Node);
    if (ft?.value === "{") {
      this.emitBraceLambda(expr);
      return;
    }
    const params = expr.parameters;
    if (params.length === 1 && !params[0]!.typeAnnotation && !params[0]!.rest && !params[0]!.optional) {
      this.emitBindingName(params[0]!.name);
    } else {
      this.write("("); this.emitFunctionParams(params); this.write(")");
    }
    if (expr.returnType) { this.write(":"); this.sp(); this.emitTypeAnno(expr.returnType as Node); }
    this.sp(); this.write("=>");
    this.sp();
    if ((expr.body as Node).kind === "BlockStatement") {
      this.emitBlock(expr.body as BlockStatement);
    } else {
      this.emitExpr(expr.body as Expr);
    }
  }

  private emitFunctionExpr(expr: FunctionExpression): void {
    if (expr.async) { this.write("async"); this.sp(); }
    if (expr.sync) { this.write("sync"); this.sp(); }
    this.write("function");
    if (expr.generator) this.write("*");
    if (expr.name) { this.sp(); this.write(expr.name.name); }
    if (expr.typeParameters?.length) this.emitTypeParams(expr.typeParameters);
    this.write("("); this.emitFunctionParams(expr.parameters); this.write(")");
    if (expr.returnType) { this.write(":"); this.sp(); this.emitTypeAnno(expr.returnType as Node); }
    this.sp(); this.emitBlock(expr.body);
  }

  private emitArrayLiteral(expr: ArrayLiteral): void {
    this.write("[");
    expr.elements.forEach((el, i) => {
      if (i > 0) { this.write(","); this.sp(); }
      if ((el as Node).kind !== "ArrayHole") this.emitExpr(el as Expr);
    });
    this.write("]");
  }

  private emitObjectLiteral(expr: ObjectLiteral): void {
    this.write("{");
    if (expr.properties.length > 0) {
      this.write(" ");
      expr.properties.forEach((p, i) => {
        if (i > 0) { this.write(","); this.sp(); }
        if ((p as Node).kind === "ObjectSpreadProperty") {
          this.write("..."); this.emitExpr((p as ObjectSpreadProperty).argument);
        } else {
          const op = p as ObjectProperty;
          if (op.computed) {
            this.write("["); this.emitExpr(op.key); this.write("]");
          } else {
            this.emitExpr(op.key);
          }
          if (!op.shorthand && !op.method) {
            this.write(":"); this.sp(); this.emitExpr(op.value);
          } else if (op.method) {
            this.write("("); this.write(")");
            this.sp(); this.emitBlock(op.value as unknown as BlockStatement);
          }
        }
      });
      this.write(" }");
    } else {
      this.write("}");
    }
  }
}

export function formatSource(source: string): string {
  try {
    // Template literals are expanded into concatenation by the tokenizer,
    // losing their original structure. Fall back to legacy for any source
    // that contains backticks.
    if (source.includes('`')) return formatSourceLegacy(source);
    const { ast, tokenizeError, fatalError, parserIssues } = parseSource(source);
    const hasIssues = tokenizeError || fatalError || !ast
      || (parserIssues?.length ?? 0) > 0
      || (ast.body.length === 0 && source.trim().length > 0);
    if (hasIssues) return formatSourceLegacy(source);
    return new AstFormatter(source).format(ast);
  } catch {
    return formatSourceLegacy(source);
  }
}
