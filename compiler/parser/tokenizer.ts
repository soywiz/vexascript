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
  type: "identifier" | "number" | "string" | "symbol" | "eof";
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
const CODE_F_UPPER = 70; // F
const CODE_L_UPPER = 76; // L
const CODE_N_UPPER = 78; // N
const CODE_Z_UPPER = 90; // Z
const CODE_BACKSLASH = 92; // \
const CODE_UNDERSCORE = 95; // _
const CODE_BACKTICK = 96; // `
const CODE_A_LOWER = 97; // a
const CODE_E_LOWER = 101; // e
const CODE_F_LOWER = 102; // f
const CODE_N_LOWER = 110; // n
const CODE_R_LOWER = 114; // r
const CODE_T_LOWER = 116; // t
const CODE_U_LOWER = 117; // u
const CODE_Z_LOWER = 122; // z
const CODE_PIPE = 124; // |

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

function readIdentifier(reader: StrReader): string {
  const start = reader.offset;
  advanceCode(reader);
  while (reader.hasMore && isIdentifierPartCode(reader.peekCode())) {
    advanceCode(reader);
  }
  return reader.str.slice(start, reader.offset);
}

function readNumber(reader: StrReader): string {
  const startPosition = snapshot(reader);
  const startOffset = reader.offset;
  advanceCode(reader);
  while (reader.hasMore && isDigitCode(reader.peekCode())) {
    advanceCode(reader);
  }

  if (
    reader.hasMore &&
    reader.peekCode() === CODE_DOT &&
    isDigitCode(reader.str.charCodeAt(reader.offset + 1))
  ) {
    advanceCode(reader);
    while (reader.hasMore && isDigitCode(reader.peekCode())) {
      advanceCode(reader);
    }
  }

  if (reader.hasMore && (reader.peekCode() === CODE_E_LOWER || reader.peekCode() === CODE_E_UPPER)) {
    advanceCode(reader);
    if (reader.hasMore && (reader.peekCode() === CODE_PLUS || reader.peekCode() === CODE_MINUS)) {
      advanceCode(reader);
    }
    if (!reader.hasMore || !isDigitCode(reader.peekCode())) {
      throw new TokenizeError("Invalid exponent in number literal", {
        start: startPosition,
        end: snapshot(reader)
      });
    }
    while (reader.hasMore && isDigitCode(reader.peekCode())) {
      advanceCode(reader);
    }
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
          throw new TokenizeError("Invalid unicode escape sequence in string literal", {
            start,
            end: snapshot(reader)
          });
        }
        const hexCode = advanceCode(reader);
        if (!isHexDigitCode(hexCode)) {
          throw new TokenizeError("Invalid unicode escape sequence in string literal", {
            start,
            end: snapshot(reader)
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
      } else if (
        escCode === CODE_BACKSLASH ||
        escCode === CODE_DOUBLE_QUOTE ||
        escCode === CODE_SINGLE_QUOTE ||
        escCode === CODE_BACKTICK
      ) {
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
        if (interpolationCode === CODE_DOUBLE_QUOTE || interpolationCode === CODE_SINGLE_QUOTE) {
          type = "string";
          value = readEscapedString(reader, interpolationCode, tokenStart);
        } else if (interpolationCode === CODE_BACKTICK) {
          throw new TokenizeError("Nested template literals are not supported yet", {
            start: tokenStart,
            end: snapshot(reader)
          });
        } else if (isIdentifierStartCode(interpolationCode)) {
          type = "identifier";
          value = readIdentifier(reader);
        } else if (isDigitCode(interpolationCode)) {
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
  if (
    ch === CODE_DOT &&
    next === CODE_DOT &&
    reader.str.charCodeAt(reader.offset + 1) === CODE_DOT
  ) {
    advanceCode(reader);
    advanceCode(reader);
    return "...";
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

export function tokenize(input: string): Token[] {
  const reader = new StrReader(input);
  const tokens: Token[] = [];
  let pendingComments: TokenComment[] = [];

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

    const start = snapshot(reader);
    let type: Token["type"];
    let value: string;

    if (code === CODE_BACKTICK) {
      const templateFragments = readTemplateAsConcatenation(reader, start);
      if (templateFragments.length === 0) {
        continue;
      }
      for (const [index, fragment] of templateFragments.entries()) {
        const leadingComments =
          index === 0 && pendingComments.length > 0
            ? pendingComments
            : fragment.leadingComments;
        tokens.push({
          ...fragment,
          index: tokens.length,
          ...(leadingComments && leadingComments.length > 0 ? { leadingComments } : {})
        });
      }
      pendingComments = [];
      continue;
    } else if (code === CODE_DOUBLE_QUOTE || code === CODE_SINGLE_QUOTE) {
      type = "string";
      value = readEscapedString(reader, code, start);
    } else if (isIdentifierStartCode(code)) {
      type = "identifier";
      value = readIdentifier(reader);
    } else if (isDigitCode(code)) {
      type = "number";
      value = readNumber(reader);
    } else {
      type = "symbol";
      value = readSymbol(reader);
    }

    tokens.push({
      type,
      value,
      index: tokens.length,
      range: {
        start,
        end: snapshot(reader)
      },
      ...(pendingComments.length > 0 ? { leadingComments: pendingComments } : {})
    });
    pendingComments = [];
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

export function tokenizeReader(input: string): ListReader<Token> {
    return new ListReader(tokenize(input))
}
