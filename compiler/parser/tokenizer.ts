import { StrReader } from "compiler/utils/StrReader";
import { ListReader } from "compiler/utils/ListReader";

export interface Token {
  type: "identifier" | "number" | "string" | "symbol";
  value: string;
}

const CODE_SPACE = 32;
const CODE_DOUBLE_QUOTE = 34;
const CODE_PERCENT = 37;
const CODE_SINGLE_QUOTE = 39;
const CODE_PLUS = 43;
const CODE_MINUS = 45;
const CODE_DOT = 46;
const CODE_SLASH = 47;
const CODE_ZERO = 48;
const CODE_NINE = 57;
const CODE_COLON = 58;
const CODE_EQUALS = 61;
const CODE_A_UPPER = 65;
const CODE_F_UPPER = 70;
const CODE_Z_UPPER = 90;
const CODE_BACKSLASH = 92;
const CODE_UNDERSCORE = 95;
const CODE_A_LOWER = 97;
const CODE_F_LOWER = 102;
const CODE_N_LOWER = 110;
const CODE_R_LOWER = 114;
const CODE_T_LOWER = 116;
const CODE_U_LOWER = 117;
const CODE_Z_LOWER = 122;
const CODE_AMPERSAND = 38;
const CODE_PIPE = 124;
const CODE_STAR = 42;

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

function readIdentifier(reader: StrReader): string {
  const start = reader.offset;
  reader.skip();
  while (reader.hasMore && isIdentifierPartCode(reader.peekCode())) {
    reader.skip();
  }
  return reader.str.slice(start, reader.offset);
}

function readNumber(reader: StrReader): string {
  const start = reader.offset;
  reader.skip();
  while (reader.hasMore && isDigitCode(reader.peekCode())) {
    reader.skip();
  }
  return reader.str.slice(start, reader.offset);
}

function readEscapedString(reader: StrReader, quoteCode: number): string {
  reader.readCode();
  let value = "";
  let segmentStart = reader.offset;

  while (reader.hasMore) {
    const code = reader.readCode();
    if (code === quoteCode) {
      value += reader.str.slice(segmentStart, reader.offset - 1);
      return value;
    }

    if (code !== CODE_BACKSLASH) {
      continue;
    }

    value += reader.str.slice(segmentStart, reader.offset - 1);

    if (!reader.hasMore) {
      throw new Error("Unterminated escape sequence in string literal");
    }

    const escCode = reader.readCode();
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
        if (!reader.hasMore) {
          throw new Error("Invalid unicode escape sequence in string literal");
        }
        const hexCode = reader.readCode();
        if (!isHexDigitCode(hexCode)) {
          throw new Error("Invalid unicode escape sequence in string literal");
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
      throw new Error(
        `Unsupported escape sequence \\${String.fromCharCode(escCode)} in string literal`
      );
    }

    segmentStart = reader.offset;
  }

  throw new Error("Unterminated string literal");
}

function readSymbol(reader: StrReader): string {
  const ch = reader.readCode();
  const next = reader.peekCode();

  if (ch === CODE_PIPE && next === CODE_PIPE) {
    reader.readCode();
    if (reader.peekCode() === CODE_EQUALS) {
      reader.readCode();
      return "||=";
    }
    return "||";
  }
  if (ch === CODE_PIPE && next === CODE_EQUALS) {
    reader.readCode();
    return "|=";
  }

  if (ch === CODE_AMPERSAND && next === CODE_AMPERSAND) {
    reader.readCode();
    if (reader.peekCode() === CODE_EQUALS) {
      reader.readCode();
      return "&&=";
    }
    return "&&";
  }
  if (ch === CODE_AMPERSAND && next === CODE_EQUALS) {
    reader.readCode();
    return "&=";
  }

  if (ch === CODE_PLUS && next === CODE_EQUALS) {
    reader.readCode();
    return "+=";
  }
  if (ch === CODE_MINUS && next === CODE_EQUALS) {
    reader.readCode();
    return "-=";
  }
  if (ch === CODE_STAR && next === CODE_STAR) {
    reader.readCode();
    return "**";
  }
  if (ch === CODE_STAR && next === CODE_EQUALS) {
    reader.readCode();
    return "*=";
  }
  if (ch === CODE_SLASH && next === CODE_EQUALS) {
    reader.readCode();
    return "/=";
  }
  if (ch === CODE_PERCENT && next === CODE_EQUALS) {
    reader.readCode();
    return "%=";
  }

  return String.fromCharCode(ch);
}

export function tokenize(input: string): Token[] {
  const reader = new StrReader(input);
  const tokens: Token[] = [];

  while (reader.hasMore) {
    const code = reader.peekCode();
    if (isWhitespaceCode(code)) {
      reader.skip();
      continue;
    }

    if (code === CODE_DOUBLE_QUOTE || code === CODE_SINGLE_QUOTE) {
      tokens.push({ type: "string", value: readEscapedString(reader, code) });
      continue;
    }

    if (isIdentifierStartCode(code)) {
      tokens.push({ type: "identifier", value: readIdentifier(reader) });
      continue;
    }

    if (isDigitCode(code)) {
      tokens.push({ type: "number", value: readNumber(reader) });
      continue;
    }

    tokens.push({ type: "symbol", value: readSymbol(reader) });
  }

  return tokens;
}

export function tokenizeReader(input: string): ListReader<Token> {
    return new ListReader(tokenize(input))
}
