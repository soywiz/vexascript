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
  type: "identifier" | "number" | "string" | "regexp" | "symbol" | "jsxText" | "eof";
  value: string;
  index: number;
  range: SourceRange;
  leadingComments?: TokenComment[];
}

export interface TokenComment {
  kind: "line" | "block";
  value: string;
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
const CODE_DOLLAR = 36; // $
const CODE_E_UPPER = 69; // E
const CODE_PERCENT = 37; // %
const CODE_AMPERSAND = 38; // &
const CODE_SINGLE_QUOTE = 39; // '
const CODE_STAR = 42; // *
const CODE_PLUS = 43; // +
const CODE_COLON = 58; // :
const CODE_MINUS = 45; // -
const CODE_DOT = 46; // .
const CODE_SLASH = 47; // /
const CODE_ZERO = 48; // 0
const CODE_NINE = 57; // 9
const CODE_LT = 60; // <
const CODE_EQUALS = 61; // =
const CODE_GT = 62; // >
const CODE_QUESTION = 63; // ?
const CODE_A_UPPER = 65; // A
const CODE_B_UPPER = 66; // B
const CODE_F_UPPER = 70; // F
const CODE_L_UPPER = 76; // L
const CODE_N_UPPER = 78; // N
const CODE_O_UPPER = 79; // O
const CODE_X_UPPER = 88; // X
const CODE_Z_UPPER = 90; // Z
const CODE_BACKSLASH = 92; // \
const CODE_UNDERSCORE = 95; // _
const CODE_BACKTICK = 96; // `
const CODE_A_LOWER = 97; // a
const CODE_B_LOWER = 98; // b
const CODE_E_LOWER = 101; // e
const CODE_F_LOWER = 102; // f
const CODE_N_LOWER = 110; // n
const CODE_O_LOWER = 111; // o
const CODE_R_LOWER = 114; // r
const CODE_T_LOWER = 116; // t
const CODE_U_LOWER = 117; // u
const CODE_X_LOWER = 120; // x
const CODE_Z_LOWER = 122; // z
const CODE_PIPE = 124; // |
const CODE_LBRACE = 123; // {
const CODE_RBRACE = 125; // }

function snapshot(reader: StrReader): SourcePosition {
  return {
    offset: reader.offset,
    line: reader.line,
    column: reader.column
  };
}

function advanceCode(reader: StrReader): number {
  return reader.readCode();
}

function isWhitespaceCode(code: number): boolean {
  return code === CODE_SPACE || code === 10 || code === 13 || code === 9;
}

function isDigitCode(code: number): boolean {
  return code >= CODE_ZERO && code <= CODE_NINE;
}

function isIdentifierStartCode(code: number): boolean {
  return (
    code === CODE_DOLLAR ||
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

function peekNextCode(reader: StrReader): number {
  return reader.str.charCodeAt(reader.offset + 1);
}

function readLineComment(reader: StrReader): TokenComment {
  const start = snapshot(reader);
  const startOffset = reader.offset;
  advanceCode(reader);
  advanceCode(reader);

  while (reader.hasMore) {
    if (reader.peekCode() === 10) {
      const end = snapshot(reader);
      return {
        kind: "line",
        value: reader.str.slice(startOffset, reader.offset),
        range: { start, end }
      };
    }
    advanceCode(reader);
  }

  const end = snapshot(reader);
  return {
    kind: "line",
    value: reader.str.slice(startOffset, reader.offset),
    range: { start, end }
  };
}

function readBlockComment(reader: StrReader, start: SourcePosition): TokenComment {
  const startOffset = reader.offset;
  advanceCode(reader);
  advanceCode(reader);

  while (reader.hasMore) {
    const code = reader.peekCode();
    const nextCode = peekNextCode(reader);
    if (code === CODE_STAR && nextCode === CODE_SLASH) {
      advanceCode(reader);
      advanceCode(reader);
      const end = snapshot(reader);
      return {
        kind: "block",
        value: reader.str.slice(startOffset, reader.offset),
        range: { start, end }
      };
    }
    advanceCode(reader);
  }

  throw new TokenizeError("Unterminated block comment", {
    start,
    end: snapshot(reader)
  });
}

function readComment(reader: StrReader): TokenComment | null {
  if (!reader.hasMore || reader.peekCode() !== CODE_SLASH) {
    return null;
  }

  const nextCode = peekNextCode(reader);
  if (nextCode === CODE_SLASH) {
    return readLineComment(reader);
  }
  if (nextCode === CODE_STAR) {
    return readBlockComment(reader, snapshot(reader));
  }

  return null;
}

function tokenAllowsRegExpLiteral(previousToken: Token | undefined): boolean {
  if (!previousToken) {
    return true;
  }
  if (previousToken.type === "eof") {
    return true;
  }
  if (previousToken.type === "identifier") {
    return [
      "return",
      "throw",
      "case",
      "delete",
      "void",
      "typeof",
      "await",
      "in",
      "instanceof",
      "is",
      "new",
      "else",
      "do"
    ].includes(previousToken.value);
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

function readRegExpLiteral(reader: StrReader, start: SourcePosition): string {
  const startOffset = reader.offset;
  advanceCode(reader);
  let inCharacterClass = false;
  let escaped = false;
  let bodyLength = 0;

  while (reader.hasMore) {
    const code = advanceCode(reader);
    if (code === 10 || code === 13) {
      throw new TokenizeError("Unterminated regular expression literal", {
        start,
        end: snapshot(reader)
      });
    }

    if (escaped) {
      escaped = false;
      bodyLength += 1;
      continue;
    }

    if (code === CODE_BACKSLASH) {
      escaped = true;
      bodyLength += 1;
      continue;
    }

    if (code === 91) {
      inCharacterClass = true;
      bodyLength += 1;
      continue;
    }

    if (code === 93) {
      inCharacterClass = false;
      bodyLength += 1;
      continue;
    }

    if (code === CODE_SLASH && !inCharacterClass) {
      if (bodyLength === 0) {
        throw new TokenizeError("Empty regular expression literal", {
          start,
          end: snapshot(reader)
        });
      }
      while (reader.hasMore && isIdentifierPartCode(reader.peekCode())) {
        advanceCode(reader);
      }
      return reader.str.slice(startOffset, reader.offset);
    }

    bodyLength += 1;
  }

  throw new TokenizeError("Unterminated regular expression literal", {
    start,
    end: snapshot(reader)
  });
}

function readIdentifier(reader: StrReader): string {
  const start = reader.offset;
  advanceCode(reader);
  while (reader.hasMore && isIdentifierPartCode(reader.peekCode())) {
    advanceCode(reader);
  }
  return reader.str.slice(start, reader.offset);
}

function isBinaryDigitCode(code: number): boolean {
  return code === CODE_ZERO || code === 49;
}

function isOctalDigitCode(code: number): boolean {
  return code >= CODE_ZERO && code <= 55;
}

function readDigitRun(
  reader: StrReader,
  startPosition: SourcePosition,
  isValidDigit: (code: number) => boolean,
  message: string,
  requireDigit: boolean = false,
  initialSawDigit: boolean = false
): void {
  let sawDigit = initialSawDigit;
  let previousWasSeparator = false;

  while (reader.hasMore) {
    const code = reader.peekCode();
    if (isValidDigit(code)) {
      sawDigit = true;
      previousWasSeparator = false;
      advanceCode(reader);
      continue;
    }
    if (code === CODE_UNDERSCORE) {
      if (!sawDigit || previousWasSeparator) {
        throw new TokenizeError(message, { start: startPosition, end: snapshot(reader) });
      }
      previousWasSeparator = true;
      advanceCode(reader);
      continue;
    }
    break;
  }

  if ((requireDigit && !sawDigit) || previousWasSeparator) {
    throw new TokenizeError(message, { start: startPosition, end: snapshot(reader) });
  }
}

function isNumericLiteralSuffixCode(code: number): boolean {
  return code === CODE_N_LOWER || code === CODE_N_UPPER || code === CODE_L_UPPER;
}

function readNumber(reader: StrReader): string {
  const startPosition = snapshot(reader);
  const startOffset = reader.offset;
  const first = advanceCode(reader);

  if (first === CODE_DOT) {
    readDigitRun(reader, startPosition, isDigitCode, "Invalid number literal", true);
  } else if (first === CODE_ZERO && reader.hasMore) {
    const baseMarker = reader.peekCode();
    if (baseMarker === CODE_X_LOWER || baseMarker === CODE_X_UPPER) {
      advanceCode(reader);
      readDigitRun(reader, startPosition, isHexDigitCode, "Invalid hex number literal", true);
      if (reader.hasMore && isIdentifierPartCode(reader.peekCode()) && !isNumericLiteralSuffixCode(reader.peekCode())) {
        throw new TokenizeError("Invalid hex number literal", { start: startPosition, end: snapshot(reader) });
      }
    } else if (baseMarker === CODE_B_LOWER || baseMarker === CODE_B_UPPER) {
      advanceCode(reader);
      readDigitRun(reader, startPosition, isBinaryDigitCode, "Invalid binary number literal", true);
      if (reader.hasMore && isIdentifierPartCode(reader.peekCode()) && !isNumericLiteralSuffixCode(reader.peekCode())) {
        throw new TokenizeError("Invalid binary number literal", { start: startPosition, end: snapshot(reader) });
      }
    } else if (baseMarker === CODE_O_LOWER || baseMarker === CODE_O_UPPER) {
      advanceCode(reader);
      readDigitRun(reader, startPosition, isOctalDigitCode, "Invalid octal number literal", true);
      if (reader.hasMore && isIdentifierPartCode(reader.peekCode()) && !isNumericLiteralSuffixCode(reader.peekCode())) {
        throw new TokenizeError("Invalid octal number literal", { start: startPosition, end: snapshot(reader) });
      }
    } else {
      readDigitRun(reader, startPosition, isDigitCode, "Invalid number literal", false, true);
    }
  } else {
    readDigitRun(reader, startPosition, isDigitCode, "Invalid number literal", false, true);
  }

  if (
    reader.hasMore &&
    reader.peekCode() === CODE_DOT &&
    isDigitCode(reader.str.charCodeAt(reader.offset + 1))
  ) {
    advanceCode(reader);
    readDigitRun(reader, startPosition, isDigitCode, "Invalid number literal", true);
  }

  if (reader.hasMore && (reader.peekCode() === CODE_E_LOWER || reader.peekCode() === CODE_E_UPPER)) {
    advanceCode(reader);
    if (reader.hasMore && (reader.peekCode() === CODE_PLUS || reader.peekCode() === CODE_MINUS)) {
      advanceCode(reader);
    }
    readDigitRun(reader, startPosition, isDigitCode, "Invalid exponent in number literal", true);
  }

  if (reader.hasMore) {
    const suffix = reader.peekCode();
    if (
      suffix === CODE_N_LOWER ||
      suffix === CODE_N_UPPER ||
      suffix === CODE_L_UPPER
    ) {
      advanceCode(reader);
    }
  }

  return reader.str.slice(startOffset, reader.offset);
}

function readEscapedString(reader: StrReader, quoteCode: number, start: SourcePosition): string {
  advanceCode(reader);
  let value = "";
  let segmentStart = reader.offset;

  while (reader.hasMore) {
    const code = advanceCode(reader);
    if (code === quoteCode) {
      value += reader.str.slice(segmentStart, reader.offset - 1);
      return value;
    }

    if (code !== CODE_BACKSLASH) {
      continue;
    }

    value += reader.str.slice(segmentStart, reader.offset - 1);

    if (!reader.hasMore) {
      throw new TokenizeError("Unterminated escape sequence in string literal", {
        start,
        end: snapshot(reader)
      });
    }

    const escCode = advanceCode(reader);
    if (escCode === CODE_N_LOWER) {
      value += "\n";
    } else if (escCode === CODE_R_LOWER) {
      value += "\r";
    } else if (escCode === CODE_T_LOWER) {
      value += "\t";
    } else if (escCode === CODE_B_LOWER) {
      value += "\b";
    } else if (escCode === CODE_F_LOWER) {
      value += "\f";
    } else if (escCode === 118) {
      value += "\v";
    } else if (escCode === CODE_ZERO) {
      value += "\0";
    } else if (
      escCode === CODE_BACKSLASH ||
      escCode === CODE_DOUBLE_QUOTE ||
      escCode === CODE_SINGLE_QUOTE ||
      escCode === CODE_SLASH ||
      escCode === CODE_DOLLAR ||
      escCode === CODE_STAR
    ) {
      value += String.fromCharCode(escCode);
    } else if (escCode === CODE_X_LOWER) {
      value += readHexEscape(reader, start, "string literal");
    } else if (escCode === CODE_U_LOWER) {
      value += readUnicodeEscape(reader, start, "string literal");
    } else if (isIdentifierStartCode(escCode) || (escCode >= 33 && escCode <= 126)) {
      value += String.fromCharCode(escCode);
    } else {
      throw new TokenizeError(
        `Unsupported escape sequence \\${String.fromCharCode(escCode)} in string literal`,
        { start, end: snapshot(reader) }
      );
    }

    segmentStart = reader.offset;
  }

  throw new TokenizeError("Unterminated string literal", {
    start,
    end: snapshot(reader)
  });
}

function readHexValue(reader: StrReader, length: number, errorMessage: string, start: SourcePosition): number {
  let hexValue = 0;
  for (let i = 0; i < length; i += 1) {
    if (!reader.hasMore) {
      throw new TokenizeError(errorMessage, {
        start,
        end: snapshot(reader)
      });
    }
    const hexCode = advanceCode(reader);
    if (!isHexDigitCode(hexCode)) {
      throw new TokenizeError(errorMessage, {
        start,
        end: snapshot(reader)
      });
    }
    hexValue <<= 4;
    if (hexCode >= CODE_ZERO && hexCode <= CODE_NINE) {
      hexValue += hexCode - CODE_ZERO;
    } else if (hexCode >= CODE_A_UPPER && hexCode <= CODE_F_UPPER) {
      hexValue += hexCode - CODE_A_UPPER + 10;
    } else {
      hexValue += hexCode - CODE_A_LOWER + 10;
    }
  }
  return hexValue;
}

function readHexEscape(reader: StrReader, start: SourcePosition, context: string): string {
  return String.fromCharCode(readHexValue(reader, 2, `Invalid hex escape sequence in ${context}`, start));
}

function readUnicodeEscape(reader: StrReader, start: SourcePosition, context: string): string {
  return String.fromCharCode(readHexValue(reader, 4, `Invalid unicode escape sequence in ${context}`, start));
}

type TokenFragment = Omit<Token, "index">;

function syntheticRangeAt(position: SourcePosition): SourceRange {
  return {
    start: position,
    end: position
  };
}

function readTemplateAsConcatenation(reader: StrReader, start: SourcePosition): TokenFragment[] {
  const fragments: TokenFragment[] = [];
  const pushFragment = (fragment: TokenFragment): void => {
    fragments.push(fragment);
  };
  const pushSymbol = (value: string, position: SourcePosition): void => {
    pushFragment({
      type: "symbol",
      value,
      range: syntheticRangeAt(position)
    });
  };

  const pushLiteralString = (
    value: string,
    literalStart: SourcePosition,
    literalEnd: SourcePosition
  ): void => {
    pushFragment({
      type: "string",
      value,
      range: {
        start: literalStart,
        end: literalEnd
      }
    });
  };

  const pushPlusIfNeeded = (position: SourcePosition): void => {
    if (fragments.length > 0) {
      pushSymbol("+", position);
    }
  };

  advanceCode(reader);
  let literalStart = snapshot(reader);
  let literalValue = "";
  let hadInterpolation = false;

  while (reader.hasMore) {
    const charStart = snapshot(reader);
    const code = advanceCode(reader);

    if (code === CODE_BACKTICK) {
      if (hadInterpolation || literalValue.length > 0) {
        pushPlusIfNeeded(charStart);
        pushLiteralString(literalValue, literalStart, charStart);
      } else {
        pushLiteralString("", start, snapshot(reader));
      }
      return fragments;
    }

    if (code === CODE_BACKSLASH) {
      if (!reader.hasMore) {
        throw new TokenizeError("Unterminated escape sequence in template literal", {
          start,
          end: snapshot(reader)
        });
      }
      const escStart = snapshot(reader);
      const escCode = advanceCode(reader);
      if (escCode === CODE_N_LOWER) {
        literalValue += "\n";
      } else if (escCode === CODE_R_LOWER) {
        literalValue += "\r";
      } else if (escCode === CODE_T_LOWER) {
        literalValue += "\t";
      } else if (escCode === CODE_B_LOWER) {
        literalValue += "\b";
      } else if (escCode === CODE_F_LOWER) {
        literalValue += "\f";
      } else if (escCode === 118) {
        literalValue += "\v";
      } else if (escCode === CODE_ZERO) {
        literalValue += "\0";
      } else if (
        escCode === CODE_BACKSLASH ||
        escCode === CODE_DOUBLE_QUOTE ||
        escCode === CODE_SINGLE_QUOTE ||
        escCode === CODE_BACKTICK ||
        escCode === CODE_SLASH ||
        escCode === CODE_DOLLAR ||
        escCode === CODE_STAR
      ) {
        literalValue += String.fromCharCode(escCode);
      } else if (escCode === CODE_X_LOWER) {
        literalValue += readHexEscape(reader, start, "template literal");
      } else if (escCode === CODE_U_LOWER) {
        literalValue += readUnicodeEscape(reader, start, "template literal");
      } else if (isIdentifierStartCode(escCode) || (escCode >= 33 && escCode <= 126)) {
        literalValue += String.fromCharCode(escCode);
      } else {
        throw new TokenizeError(
          `Unsupported escape sequence \\${String.fromCharCode(escCode)} in template literal`,
          { start: escStart, end: snapshot(reader) }
        );
      }
      continue;
    }

    if (code === CODE_DOLLAR && reader.hasMore && reader.peekCode() === 123) {
      hadInterpolation = true;
      const interpolationStart = charStart;
      if (literalValue.length > 0 || fragments.length === 0) {
        pushPlusIfNeeded(interpolationStart);
        pushLiteralString(literalValue, literalStart, interpolationStart);
      }
      literalValue = "";

      const interpolationOpen = snapshot(reader);
      advanceCode(reader);

      pushPlusIfNeeded(interpolationOpen);
      pushSymbol("(", interpolationOpen);

      let interpolationPendingComments: TokenComment[] = [];
      let interpolationPreviousToken: Token | undefined = { type: "symbol", value: "(", index: -1, range: syntheticRangeAt(interpolationOpen) };
      let depth = 1;
      while (reader.hasMore) {
        const interpolationCode = reader.peekCode();

        if (isWhitespaceCode(interpolationCode)) {
          advanceCode(reader);
          continue;
        }

        const comment = readComment(reader);
        if (comment) {
          interpolationPendingComments.push(comment);
          continue;
        }

        const tokenStart = snapshot(reader);
        if (interpolationCode === 123) {
          depth += 1;
          advanceCode(reader);
          pushFragment({
            type: "symbol",
            value: "{",
            range: {
              start: tokenStart,
              end: snapshot(reader)
            },
            ...(interpolationPendingComments.length > 0
              ? { leadingComments: interpolationPendingComments }
              : {})
          });
          interpolationPendingComments = [];
          continue;
        }

        if (interpolationCode === 125) {
          depth -= 1;
          if (depth === 0) {
            advanceCode(reader);
            break;
          }
          advanceCode(reader);
          pushFragment({
            type: "symbol",
            value: "}",
            range: {
              start: tokenStart,
              end: snapshot(reader)
            },
            ...(interpolationPendingComments.length > 0
              ? { leadingComments: interpolationPendingComments }
              : {})
          });
          interpolationPendingComments = [];
          continue;
        }

        let type: Token["type"];
        let value: string;
        if (
          interpolationCode === CODE_SLASH &&
          reader.offset + 1 < reader.str.length &&
          peekNextCode(reader) !== CODE_SLASH &&
          peekNextCode(reader) !== CODE_STAR &&
          peekNextCode(reader) !== CODE_EQUALS &&
          tokenAllowsRegExpLiteral(interpolationPreviousToken)
        ) {
          type = "regexp";
          value = readRegExpLiteral(reader, tokenStart);
        } else if (interpolationCode === CODE_DOUBLE_QUOTE || interpolationCode === CODE_SINGLE_QUOTE) {
          type = "string";
          value = readEscapedString(reader, interpolationCode, tokenStart);
        } else if (interpolationCode === CODE_BACKTICK) {
          const nestedFragments = readTemplateAsConcatenation(reader, tokenStart);
          for (const fragment of nestedFragments) {
            pushFragment({
              ...fragment,
              ...(interpolationPendingComments.length > 0
                ? { leadingComments: interpolationPendingComments }
                : {})
            });
            interpolationPendingComments = [];
            interpolationPreviousToken = { ...fragment, index: -1 };
          }
          continue;
        } else if (isIdentifierStartCode(interpolationCode)) {
          type = "identifier";
          value = readIdentifier(reader);
        } else if (
          isDigitCode(interpolationCode) ||
          (interpolationCode === CODE_DOT && isDigitCode(peekNextCode(reader)))
        ) {
          type = "number";
          value = readNumber(reader);
        } else {
          type = "symbol";
          value = readSymbol(reader);
        }

        pushFragment({
          type,
          value,
          range: {
            start: tokenStart,
            end: snapshot(reader)
          },
          ...(interpolationPendingComments.length > 0
            ? { leadingComments: interpolationPendingComments }
            : {})
        });
        interpolationPreviousToken = { type, value, index: -1, range: { start: tokenStart, end: snapshot(reader) } };
        interpolationPendingComments = [];
      }

      if (depth !== 0) {
        throw new TokenizeError("Unterminated template interpolation", {
          start,
          end: snapshot(reader)
        });
      }

      pushSymbol(")", snapshot(reader));
      literalStart = snapshot(reader);
      continue;
    }

    literalValue += String.fromCharCode(code);
  }

  throw new TokenizeError("Unterminated template literal", {
    start,
    end: snapshot(reader)
  });
}

function readSymbol(reader: StrReader): string {
  const ch = advanceCode(reader);
  const next = reader.peekCode();

  if (ch === CODE_PIPE && next === CODE_PIPE) {
    advanceCode(reader);
    if (reader.peekCode() === CODE_EQUALS) {
      advanceCode(reader);
      return "||=";
    }
    return "||";
  }
  if (ch === CODE_PIPE && next === CODE_EQUALS) {
    advanceCode(reader);
    return "|=";
  }

  if (ch === CODE_AMPERSAND && next === CODE_AMPERSAND) {
    advanceCode(reader);
    if (reader.peekCode() === CODE_EQUALS) {
      advanceCode(reader);
      return "&&=";
    }
    return "&&";
  }
  if (ch === CODE_AMPERSAND && next === CODE_EQUALS) {
    advanceCode(reader);
    return "&=";
  }

  if (ch === CODE_PLUS && next === CODE_EQUALS) {
    advanceCode(reader);
    return "+=";
  }
  if (ch === CODE_PLUS && next === CODE_PLUS) {
    advanceCode(reader);
    return "++";
  }
  if (ch === CODE_COLON && next === CODE_COLON) {
    advanceCode(reader);
    return "::";
  }
  if (ch === CODE_QUESTION && next === CODE_QUESTION) {
    advanceCode(reader);
    if (reader.peekCode() === CODE_EQUALS) {
      advanceCode(reader);
      return "??=";
    }
    return "??";
  }
  if (ch === CODE_QUESTION && next === CODE_DOT) {
    advanceCode(reader);
    return "?.";
  }
  if (ch === CODE_BANG && next === CODE_DOT) {
    advanceCode(reader);
    return "!.";
  }
  if (ch === CODE_DOT && next === CODE_DOT) {
    const afterTwo = reader.str.charCodeAt(reader.offset + 1);
    if (afterTwo === CODE_DOT) {
      advanceCode(reader);
      advanceCode(reader);
      return "...";
    }
    if (afterTwo === CODE_LT) {
      advanceCode(reader);
      advanceCode(reader);
      return "..<";
    }
    advanceCode(reader);
    return "..";
  }
  if (ch === CODE_EQUALS && next === CODE_EQUALS) {
    advanceCode(reader);
    if (reader.peekCode() === CODE_EQUALS) {
      advanceCode(reader);
      return "===";
    }
    return "==";
  }
  if (ch === CODE_EQUALS && next === CODE_GT) {
    advanceCode(reader);
    return "=>";
  }
  if (ch === CODE_BANG && next === CODE_EQUALS) {
    advanceCode(reader);
    if (reader.peekCode() === CODE_EQUALS) {
      advanceCode(reader);
      return "!==";
    }
    return "!=";
  }
  if (ch === CODE_MINUS && next === CODE_EQUALS) {
    advanceCode(reader);
    return "-=";
  }
  if (ch === CODE_MINUS && next === CODE_GT) {
    advanceCode(reader);
    return "->";
  }
  if (ch === CODE_MINUS && next === CODE_MINUS) {
    advanceCode(reader);
    return "--";
  }
  if (ch === CODE_STAR && next === CODE_STAR) {
    advanceCode(reader);
    return "**";
  }
  if (ch === CODE_STAR && next === CODE_EQUALS) {
    advanceCode(reader);
    return "*=";
  }
  if (ch === CODE_SLASH && next === CODE_EQUALS) {
    advanceCode(reader);
    return "/=";
  }
  if (ch === CODE_PERCENT && next === CODE_EQUALS) {
    advanceCode(reader);
    return "%=";
  }
  if (ch === CODE_LT && next === CODE_LT) {
    advanceCode(reader);
    if (reader.peekCode() === CODE_EQUALS) {
      advanceCode(reader);
      return "<<=";
    }
    return "<<";
  }
  if (ch === CODE_LT && next === CODE_EQUALS) {
    advanceCode(reader);
    return "<=";
  }
  if (ch === CODE_GT && next === CODE_GT) {
    advanceCode(reader);
    if (reader.peekCode() === CODE_GT) {
      advanceCode(reader);
      if (reader.peekCode() === CODE_EQUALS) {
        advanceCode(reader);
        return ">>>=";
      }
      return ">>>";
    }
    if (reader.peekCode() === CODE_EQUALS) {
      advanceCode(reader);
      return ">>=";
    }
    return ">>";
  }
  if (ch === CODE_GT && next === CODE_EQUALS) {
    advanceCode(reader);
    return ">=";
  }

  return String.fromCharCode(ch);
}

export interface TokenizeOptions {
  /**
   * When enabled, embedded XML/JSX is recognized: a `<` in expression position
   * followed by a tag name (or `>` for a fragment) starts a JSX element instead
   * of a less-than operator. VexaScript always tokenizes with this on; TypeScript
   * mode enables it through the `jsx` parser option.
   */
  jsx?: boolean;
}

export function tokenize(input: string, options: TokenizeOptions = {}): Token[] {
  const jsxEnabled = options.jsx ?? false;
  const reader = new StrReader(input);
  const tokens: Token[] = [];
  let pendingComments: TokenComment[] = [];
  let previousSignificantToken: Token | undefined;

  const pushFragment = (fragment: TokenFragment): Token => {
    const leadingComments =
      pendingComments.length > 0 ? pendingComments : fragment.leadingComments;
    const token: Token = {
      type: fragment.type,
      value: fragment.value,
      index: tokens.length,
      range: fragment.range,
      ...(leadingComments && leadingComments.length > 0 ? { leadingComments } : {})
    };
    tokens.push(token);
    previousSignificantToken = token;
    pendingComments = [];
    return token;
  };

  const pushSymbol = (value: string, start: SourcePosition): void => {
    pushFragment({ type: "symbol", value, range: { start, end: snapshot(reader) } });
  };

  const skipInlineWhitespace = (): void => {
    while (reader.hasMore && isWhitespaceCode(reader.peekCode())) {
      advanceCode(reader);
    }
  };

  // Reads a single JSX name segment, allowing hyphens for custom elements and
  // namespaced/data attributes (e.g. `data-id`).
  const readJsxNameToken = (): void => {
    const start = snapshot(reader);
    let value = "";
    while (reader.hasMore) {
      const code = reader.peekCode();
      if (isIdentifierPartCode(code) || code === CODE_MINUS) {
        value += String.fromCharCode(advanceCode(reader));
        continue;
      }
      break;
    }
    pushFragment({ type: "identifier", value, range: { start, end: snapshot(reader) } });
  };

  // Reads a (possibly dotted) JSX tag name such as `div` or `Foo.Bar`.
  const readJsxTagName = (): void => {
    readJsxNameToken();
    while (reader.hasMore && reader.peekCode() === CODE_DOT) {
      const dotStart = snapshot(reader);
      advanceCode(reader);
      pushSymbol(".", dotStart);
      readJsxNameToken();
    }
  };

  // Reads `{ ... }` as the open brace, the inner code tokens (which may contain
  // nested JSX), and the matching close brace.
  const readJsxExpressionContainer = (): void => {
    const braceStart = snapshot(reader);
    advanceCode(reader);
    pushSymbol("{", braceStart);
    let depth = 1;
    while (reader.hasMore) {
      const code = reader.peekCode();
      if (isWhitespaceCode(code)) {
        advanceCode(reader);
        continue;
      }
      const comment = readComment(reader);
      if (comment) {
        pendingComments.push(comment);
        continue;
      }
      if (code === CODE_LBRACE) {
        const start = snapshot(reader);
        advanceCode(reader);
        pushSymbol("{", start);
        depth += 1;
        continue;
      }
      if (code === CODE_RBRACE) {
        const start = snapshot(reader);
        advanceCode(reader);
        depth -= 1;
        pushSymbol("}", start);
        if (depth === 0) {
          return;
        }
        continue;
      }
      readCodeToken();
    }
    throw new TokenizeError("Unterminated JSX expression container", {
      start: braceStart,
      end: snapshot(reader)
    });
  };

  const readJsxAttributes = (): void => {
    while (true) {
      skipInlineWhitespace();
      if (!reader.hasMore) {
        throw new TokenizeError("Unterminated JSX opening tag", {
          start: snapshot(reader),
          end: snapshot(reader)
        });
      }
      const code = reader.peekCode();
      if (code === CODE_GT || code === CODE_SLASH) {
        return;
      }
      if (code === CODE_LBRACE) {
        // Spread attribute `{...expr}`.
        readJsxExpressionContainer();
        continue;
      }
      if (!isIdentifierStartCode(code)) {
        throw new TokenizeError("Unexpected character in JSX opening tag", {
          start: snapshot(reader),
          end: snapshot(reader)
        });
      }
      readJsxNameToken();
      skipInlineWhitespace();
      if (reader.peekCode() === CODE_EQUALS) {
        const eqStart = snapshot(reader);
        advanceCode(reader);
        pushSymbol("=", eqStart);
        skipInlineWhitespace();
        const valueCode = reader.peekCode();
        if (valueCode === CODE_DOUBLE_QUOTE || valueCode === CODE_SINGLE_QUOTE) {
          const stringStart = snapshot(reader);
          const value = readEscapedString(reader, valueCode, stringStart);
          pushFragment({ type: "string", value, range: { start: stringStart, end: snapshot(reader) } });
        } else if (valueCode === CODE_LBRACE) {
          readJsxExpressionContainer();
        } else {
          throw new TokenizeError("Expected JSX attribute value", {
            start: snapshot(reader),
            end: snapshot(reader)
          });
        }
      }
    }
  };

  const readJsxClosingTag = (): void => {
    const ltStart = snapshot(reader);
    advanceCode(reader);
    pushSymbol("<", ltStart);
    const slashStart = snapshot(reader);
    advanceCode(reader);
    pushSymbol("/", slashStart);
    skipInlineWhitespace();
    if (reader.peekCode() !== CODE_GT) {
      readJsxTagName();
      skipInlineWhitespace();
    }
    const gtStart = snapshot(reader);
    if (reader.peekCode() !== CODE_GT) {
      throw new TokenizeError("Expected '>' to close JSX closing tag", {
        start: gtStart,
        end: snapshot(reader)
      });
    }
    advanceCode(reader);
    pushSymbol(">", gtStart);
  };

  const readJsxChildren = (): void => {
    while (true) {
      const textStart = snapshot(reader);
      let text = "";
      while (reader.hasMore) {
        const code = reader.peekCode();
        if (code === CODE_LT || code === CODE_LBRACE) {
          break;
        }
        text += String.fromCharCode(advanceCode(reader));
      }
      if (text.length > 0) {
        pushFragment({ type: "jsxText", value: text, range: { start: textStart, end: snapshot(reader) } });
      }
      if (!reader.hasMore) {
        throw new TokenizeError("Unterminated JSX element", {
          start: textStart,
          end: snapshot(reader)
        });
      }
      const code = reader.peekCode();
      if (code === CODE_LBRACE) {
        readJsxExpressionContainer();
        continue;
      }
      // code === CODE_LT
      if (peekNextCode(reader) === CODE_SLASH) {
        readJsxClosingTag();
        return;
      }
      readJsxElement();
    }
  };

  const readJsxElement = (): void => {
    const ltStart = snapshot(reader);
    advanceCode(reader);
    pushSymbol("<", ltStart);

    if (reader.peekCode() === CODE_GT) {
      // Fragment `<>...</>`.
      const gtStart = snapshot(reader);
      advanceCode(reader);
      pushSymbol(">", gtStart);
      readJsxChildren();
      return;
    }

    readJsxTagName();
    readJsxAttributes();

    if (reader.peekCode() === CODE_SLASH) {
      const slashStart = snapshot(reader);
      advanceCode(reader);
      pushSymbol("/", slashStart);
      const gtStart = snapshot(reader);
      if (reader.peekCode() !== CODE_GT) {
        throw new TokenizeError("Expected '>' to close self-closing JSX element", {
          start: gtStart,
          end: snapshot(reader)
        });
      }
      advanceCode(reader);
      pushSymbol(">", gtStart);
      return;
    }

    const gtStart = snapshot(reader);
    if (reader.peekCode() !== CODE_GT) {
      throw new TokenizeError("Expected '>' in JSX opening tag", {
        start: gtStart,
        end: snapshot(reader)
      });
    }
    advanceCode(reader);
    pushSymbol(">", gtStart);
    readJsxChildren();
  };

  // Reads a single non-trivia token (or JSX element / template expansion).
  const readCodeToken = (): void => {
    const code = reader.peekCode();
    const start = snapshot(reader);

    if (
      jsxEnabled &&
      code === CODE_LT &&
      tokenAllowsRegExpLiteral(previousSignificantToken)
    ) {
      const nextCode = peekNextCode(reader);
      if (isIdentifierStartCode(nextCode) || nextCode === CODE_GT) {
        readJsxElement();
        return;
      }
    }

    if (code === CODE_BACKTICK) {
      const templateFragments = readTemplateAsConcatenation(reader, start);
      for (const fragment of templateFragments) {
        pushFragment(fragment);
      }
      return;
    }

    let type: Token["type"];
    let value: string;
    if (
      code === CODE_SLASH &&
      peekNextCode(reader) !== CODE_SLASH &&
      peekNextCode(reader) !== CODE_STAR &&
      peekNextCode(reader) !== CODE_EQUALS &&
      tokenAllowsRegExpLiteral(previousSignificantToken)
    ) {
      type = "regexp";
      value = readRegExpLiteral(reader, start);
    } else if (code === CODE_DOUBLE_QUOTE || code === CODE_SINGLE_QUOTE) {
      type = "string";
      value = readEscapedString(reader, code, start);
    } else if (isIdentifierStartCode(code)) {
      type = "identifier";
      value = readIdentifier(reader);
    } else if (isDigitCode(code) || (code === CODE_DOT && isDigitCode(peekNextCode(reader)))) {
      type = "number";
      value = readNumber(reader);
    } else {
      type = "symbol";
      value = readSymbol(reader);
    }

    pushFragment({ type, value, range: { start, end: snapshot(reader) } });
  };

  while (reader.hasMore) {
    const code = reader.peekCode();
    if (isWhitespaceCode(code)) {
      advanceCode(reader);
      continue;
    }

    const comment = readComment(reader);
    if (comment) {
      pendingComments.push(comment);
      continue;
    }

    readCodeToken();
  }

  const eofPosition = snapshot(reader);
  tokens.push({
    type: "eof",
    value: "<eof>",
    index: tokens.length,
    range: {
      start: eofPosition,
      end: eofPosition
    },
    ...(pendingComments.length > 0 ? { leadingComments: pendingComments } : {})
  });

  return tokens;
}

export function tokenizeReader(input: string, options: TokenizeOptions = {}): ListReader<Token> {
    return new ListReader(tokenize(input, options))
}
