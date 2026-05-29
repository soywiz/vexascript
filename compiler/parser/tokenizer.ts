import { StrReader } from "compiler/utils/StrReader";
import { ListReader } from "compiler/utils/ListReader";

export interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

export interface Token {
  type: "identifier" | "number" | "string" | "symbol";
  value: string;
  index: number;
  range: SourceRange;
}

export class TokenizeError extends Error {
  range: SourceRange;

  constructor(message: string, range: SourceRange) {
    super(message);
    this.name = "TokenizeError";
    this.range = range;
  }
}

const CODE_SPACE = 32; // " "
const CODE_BANG = 33; // !
const CODE_DOUBLE_QUOTE = 34; // "
const CODE_PERCENT = 37; // %
const CODE_AMPERSAND = 38; // &
const CODE_SINGLE_QUOTE = 39; // '
const CODE_STAR = 42; // *
const CODE_PLUS = 43; // +
const CODE_MINUS = 45; // -
const CODE_DOT = 46; // .
const CODE_SLASH = 47; // /
const CODE_ZERO = 48; // 0
const CODE_NINE = 57; // 9
const CODE_COLON = 58; // :
const CODE_LT = 60; // <
const CODE_EQUALS = 61; // =
const CODE_GT = 62; // >
const CODE_QUESTION = 63; // ?
const CODE_A_UPPER = 65; // A
const CODE_F_UPPER = 70; // F
const CODE_Z_UPPER = 90; // Z
const CODE_BACKSLASH = 92; // \
const CODE_UNDERSCORE = 95; // _
const CODE_A_LOWER = 97; // a
const CODE_F_LOWER = 102; // f
const CODE_N_LOWER = 110; // n
const CODE_R_LOWER = 114; // r
const CODE_T_LOWER = 116; // t
const CODE_U_LOWER = 117; // u
const CODE_Z_LOWER = 122; // z
const CODE_PIPE = 124; // |

interface Scanner {
  reader: StrReader;
  line: number;
  column: number;
}

function snapshot(scanner: Scanner): SourcePosition {
  return {
    offset: scanner.reader.offset,
    line: scanner.line,
    column: scanner.column
  };
}

function advanceCode(scanner: Scanner): number {
  const code = scanner.reader.readCode();
  if (code === 10) {
    scanner.line += 1;
    scanner.column = 0;
  } else {
    scanner.column += 1;
  }
  return code;
}

function isWhitespaceCode(code: number): boolean {
  return code === CODE_SPACE || code === 10 || code === 13 || code === 9;
}

function isDigitCode(code: number): boolean {
  return code >= CODE_ZERO && code <= CODE_NINE;
}

function isIdentifierStartCode(code: number): boolean {
  return (
    code === CODE_UNDERSCORE ||
    (code >= CODE_A_UPPER && code <= CODE_Z_UPPER) ||
    (code >= CODE_A_LOWER && code <= CODE_Z_LOWER)
  );
}

function isIdentifierPartCode(code: number): boolean {
  return isIdentifierStartCode(code) || isDigitCode(code);
}

function isHexDigitCode(code: number): boolean {
  return (
    (code >= CODE_ZERO && code <= CODE_NINE) ||
    (code >= CODE_A_UPPER && code <= CODE_F_UPPER) ||
    (code >= CODE_A_LOWER && code <= CODE_F_LOWER)
  );
}

function readIdentifier(scanner: Scanner): string {
  const start = scanner.reader.offset;
  advanceCode(scanner);
  while (scanner.reader.hasMore && isIdentifierPartCode(scanner.reader.peekCode())) {
    advanceCode(scanner);
  }
  return scanner.reader.str.slice(start, scanner.reader.offset);
}

function readNumber(scanner: Scanner): string {
  const start = scanner.reader.offset;
  advanceCode(scanner);
  while (scanner.reader.hasMore && isDigitCode(scanner.reader.peekCode())) {
    advanceCode(scanner);
  }
  return scanner.reader.str.slice(start, scanner.reader.offset);
}

function readEscapedString(scanner: Scanner, quoteCode: number, start: SourcePosition): string {
  advanceCode(scanner);
  let value = "";
  let segmentStart = scanner.reader.offset;

  while (scanner.reader.hasMore) {
    const code = advanceCode(scanner);
    if (code === quoteCode) {
      value += scanner.reader.str.slice(segmentStart, scanner.reader.offset - 1);
      return value;
    }

    if (code !== CODE_BACKSLASH) {
      continue;
    }

    value += scanner.reader.str.slice(segmentStart, scanner.reader.offset - 1);

    if (!scanner.reader.hasMore) {
      throw new TokenizeError("Unterminated escape sequence in string literal", {
        start,
        end: snapshot(scanner)
      });
    }

    const escCode = advanceCode(scanner);
    if (escCode === CODE_N_LOWER) {
      value += "\n";
    } else if (escCode === CODE_R_LOWER) {
      value += "\r";
    } else if (escCode === CODE_T_LOWER) {
      value += "\t";
    } else if (
      escCode === CODE_BACKSLASH ||
      escCode === CODE_DOUBLE_QUOTE ||
      escCode === CODE_SINGLE_QUOTE
    ) {
      value += String.fromCharCode(escCode);
    } else if (escCode === CODE_U_LOWER) {
      let hexCodePoint = 0;
      for (let i = 0; i < 4; i++) {
        if (!scanner.reader.hasMore) {
          throw new TokenizeError("Invalid unicode escape sequence in string literal", {
            start,
            end: snapshot(scanner)
          });
        }
        const hexCode = advanceCode(scanner);
        if (!isHexDigitCode(hexCode)) {
          throw new TokenizeError("Invalid unicode escape sequence in string literal", {
            start,
            end: snapshot(scanner)
          });
        }
        hexCodePoint <<= 4;
        if (hexCode >= CODE_ZERO && hexCode <= CODE_NINE) {
          hexCodePoint += hexCode - CODE_ZERO;
        } else if (hexCode >= CODE_A_UPPER && hexCode <= CODE_F_UPPER) {
          hexCodePoint += hexCode - CODE_A_UPPER + 10;
        } else {
          hexCodePoint += hexCode - CODE_A_LOWER + 10;
        }
      }
      value += String.fromCharCode(hexCodePoint);
    } else {
      throw new TokenizeError(
        `Unsupported escape sequence \\${String.fromCharCode(escCode)} in string literal`,
        { start, end: snapshot(scanner) }
      );
    }

    segmentStart = scanner.reader.offset;
  }

  throw new TokenizeError("Unterminated string literal", {
    start,
    end: snapshot(scanner)
  });
}

function readSymbol(scanner: Scanner): string {
  const ch = advanceCode(scanner);
  const next = scanner.reader.peekCode();

  if (ch === CODE_PIPE && next === CODE_PIPE) {
    advanceCode(scanner);
    if (scanner.reader.peekCode() === CODE_EQUALS) {
      advanceCode(scanner);
      return "||=";
    }
    return "||";
  }
  if (ch === CODE_PIPE && next === CODE_EQUALS) {
    advanceCode(scanner);
    return "|=";
  }

  if (ch === CODE_AMPERSAND && next === CODE_AMPERSAND) {
    advanceCode(scanner);
    if (scanner.reader.peekCode() === CODE_EQUALS) {
      advanceCode(scanner);
      return "&&=";
    }
    return "&&";
  }
  if (ch === CODE_AMPERSAND && next === CODE_EQUALS) {
    advanceCode(scanner);
    return "&=";
  }

  if (ch === CODE_PLUS && next === CODE_EQUALS) {
    advanceCode(scanner);
    return "+=";
  }
  if (ch === CODE_QUESTION && next === CODE_DOT) {
    advanceCode(scanner);
    return "?.";
  }
  if (ch === CODE_BANG && next === CODE_DOT) {
    advanceCode(scanner);
    return "!.";
  }
  if (ch === CODE_EQUALS && next === CODE_EQUALS) {
    advanceCode(scanner);
    if (scanner.reader.peekCode() === CODE_EQUALS) {
      advanceCode(scanner);
      return "===";
    }
    return "==";
  }
  if (ch === CODE_BANG && next === CODE_EQUALS) {
    advanceCode(scanner);
    if (scanner.reader.peekCode() === CODE_EQUALS) {
      advanceCode(scanner);
      return "!==";
    }
    return "!=";
  }
  if (ch === CODE_MINUS && next === CODE_EQUALS) {
    advanceCode(scanner);
    return "-=";
  }
  if (ch === CODE_STAR && next === CODE_STAR) {
    advanceCode(scanner);
    return "**";
  }
  if (ch === CODE_STAR && next === CODE_EQUALS) {
    advanceCode(scanner);
    return "*=";
  }
  if (ch === CODE_SLASH && next === CODE_EQUALS) {
    advanceCode(scanner);
    return "/=";
  }
  if (ch === CODE_PERCENT && next === CODE_EQUALS) {
    advanceCode(scanner);
    return "%=";
  }
  if (ch === CODE_LT && next === CODE_EQUALS) {
    advanceCode(scanner);
    return "<=";
  }
  if (ch === CODE_GT && next === CODE_EQUALS) {
    advanceCode(scanner);
    return ">=";
  }

  return String.fromCharCode(ch);
}

export function tokenize(input: string): Token[] {
  const scanner: Scanner = {
    reader: new StrReader(input),
    line: 0,
    column: 0
  };
  const tokens: Token[] = [];

  while (scanner.reader.hasMore) {
    const code = scanner.reader.peekCode();
    if (isWhitespaceCode(code)) {
      advanceCode(scanner);
      continue;
    }

    const start = snapshot(scanner);
    let type: Token["type"];
    let value: string;

    if (code === CODE_DOUBLE_QUOTE || code === CODE_SINGLE_QUOTE) {
      type = "string";
      value = readEscapedString(scanner, code, start);
    } else if (isIdentifierStartCode(code)) {
      type = "identifier";
      value = readIdentifier(scanner);
    } else if (isDigitCode(code)) {
      type = "number";
      value = readNumber(scanner);
    } else {
      type = "symbol";
      value = readSymbol(scanner);
    }

    tokens.push({
      type,
      value,
      index: tokens.length,
      range: {
        start,
        end: snapshot(scanner)
      }
    });
  }

  return tokens;
}

export function tokenizeReader(input: string): ListReader<Token> {
    return new ListReader(tokenize(input))
}
