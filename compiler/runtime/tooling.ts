export interface Token {
  type: "identifier" | "number" | "symbol";
  value: string;
}

export function tokenize(input: string): Token[] {
  const raw = input.match(/[A-Za-z_][A-Za-z0-9_]*|\d+|[^\s]/g) ?? [];

  return raw.map((part) => {
    if (/^[A-Za-z_]/.test(part)) {
      return { type: "identifier", value: part } as const;
    }
    if (/^\d+$/.test(part)) {
      return { type: "number", value: part } as const;
    }
    return { type: "symbol", value: part } as const;
  });
}

export function toAstPreview(input: string): object {
  return {
    kind: "Program",
    body: tokenize(input).map((token) => ({
      kind: "TokenNode",
      token
    }))
  };
}
