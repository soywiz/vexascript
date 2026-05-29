import { ListReader } from "compiler/utils/ListReader";

export interface Token {
  type: "identifier" | "number" | "string" | "symbol";
  value: string;
}

function decodeStringLiteral(literal: string): string {
  const quote = literal[0];
  const body = literal.slice(1, -1);
  let result = "";

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      result += ch;
      continue;
    }

    i++;
    const esc = body[i];
    if (esc === undefined) {
      throw new Error("Unterminated escape sequence in string literal");
    }

    if (esc === "n") {
      result += "\n";
      continue;
    }
    if (esc === "r") {
      result += "\r";
      continue;
    }
    if (esc === "t") {
      result += "\t";
      continue;
    }
    if (esc === "\\" || esc === "\"" || esc === "'") {
      result += esc;
      continue;
    }
    if (esc === "u") {
      const hex = body.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw new Error("Invalid unicode escape sequence in string literal");
      }
      result += String.fromCharCode(parseInt(hex, 16));
      i += 4;
      continue;
    }

    throw new Error(`Unsupported escape sequence \\${esc} in string literal`);
  }

  if (quote !== "\"" && quote !== "'") {
    throw new Error("Invalid string literal quote");
  }

  return result;
}

export function tokenize(input: string): Token[] {
  const raw = input.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\|\|=|&&=|\+=|-=|\*=|\/=|%=|&=|\|=|\*\*|\|\||&&|[A-Za-z_][A-Za-z0-9_]*|\d+|[^\s]/g) ?? [];

  return raw.map((part) => {
    if (part.startsWith("\"") || part.startsWith("'")) {
      return { type: "string", value: decodeStringLiteral(part) } as const;
    }
    if (/^[A-Za-z_]/.test(part)) {
      return { type: "identifier", value: part } as const;
    }
    if (/^\d+$/.test(part)) {
      return { type: "number", value: part } as const;
    }
    return { type: "symbol", value: part } as const;
  });
}

export function tokenizeReader(input: string): ListReader<Token> {
    return new ListReader(tokenize(input))
}
