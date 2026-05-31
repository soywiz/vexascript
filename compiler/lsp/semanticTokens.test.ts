import { describe, expect, it } from "vitest";
import { createAnalysisSession } from "./analysisSession";
import { createSemanticTokens, MYLANG_SEMANTIC_TOKENS_LEGEND } from "./semanticTokens";

interface DecodedToken {
  line: number;
  character: number;
  length: number;
  tokenType: string;
  lexeme: string;
}

function decodeTokens(source: string, data: number[]): DecodedToken[] {
  const lines = source.split("\n");
  const decoded: DecodedToken[] = [];
  let line = 0;
  let character = 0;

  for (let i = 0; i + 4 < data.length; i += 5) {
    line += data[i]!;
    if (data[i] === 0) {
      character += data[i + 1]!;
    } else {
      character = data[i + 1]!;
    }

    const length = data[i + 2]!;
    const tokenTypeIndex = data[i + 3]!;
    const tokenType = MYLANG_SEMANTIC_TOKENS_LEGEND.tokenTypes[tokenTypeIndex] ?? "unknown";
    const lineText = lines[line] ?? "";
    const lexeme = lineText.slice(character, character + length);
    decoded.push({
      line,
      character,
      length,
      tokenType,
      lexeme
    });
  }

  return decoded;
}

describe("semantic tokens", () => {
  it("highlights keywords like switch/case/default/new/declare", () => {
    const source =
      "declare class Console {\n" +
      "  log(a: number)\n" +
      "}\n" +
      "declare var console: Console\n" +
      "switch (new Console()) {\n" +
      "  case console:\n" +
      "    break\n" +
      "  default:\n" +
      "    break\n" +
      "}\n";

    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });

    const decoded = decodeTokens(source, semantic.data);
    const byPosition = new Map(
      decoded.map((token) => [`${token.line}:${token.character}`, token.tokenType])
    );

    expect(byPosition.get("0:0")).toBe("keyword");
    expect(byPosition.get("0:8")).toBe("keyword");
    expect(byPosition.get("3:0")).toBe("keyword");
    expect(byPosition.get("3:8")).toBe("keyword");
    expect(byPosition.get("4:0")).toBe("keyword");
    expect(byPosition.get("4:8")).toBe("keyword");
    expect(byPosition.get("5:2")).toBe("keyword");
    expect(byPosition.get("7:2")).toBe("keyword");
  });

  it("highlights operators and primitive literals", () => {
    const source = "let a: int = 1 + 2\na += 3\n";
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });
    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.some((token) => token.lexeme === "+" && token.tokenType === "operator")).toBe(
      true
    );
    expect(decoded.some((token) => token.lexeme === "+=" && token.tokenType === "operator")).toBe(
      true
    );
    expect(decoded.some((token) => token.lexeme === "1" && token.tokenType === "number")).toBe(
      true
    );
    expect(decoded.some((token) => token.lexeme === "2" && token.tokenType === "number")).toBe(
      true
    );
  });

  it("supports range requests", () => {
    const source =
      "switch (a) {\n" +
      "  case 1:\n" +
      "    break\n" +
      "  default:\n" +
      "    break\n" +
      "}\n";

    const semantic = createSemanticTokens({
      text: source,
      range: {
        start: { line: 1, character: 0 },
        end: { line: 3, character: 0 }
      }
    });
    const decoded = decodeTokens(source, semantic.data);
    const lexemes = decoded.map((token) => token.lexeme);

    expect(lexemes).toContain("case");
    expect(lexemes).toContain("break");
    expect(lexemes).not.toContain("switch");
    expect(lexemes).not.toContain("default");
  });

  it("does not fail with parser errors", () => {
    const source =
      "asdsa declare class Console {\n" +
      "declare var console: Console\n" +
      "switch (new Console()) {\n";
    const session = createAnalysisSession(source);

    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });
    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.some((token) => token.lexeme === "declare" && token.tokenType === "keyword")).toBe(
      true
    );
    expect(decoded.some((token) => token.lexeme === "class" && token.tokenType === "keyword")).toBe(
      true
    );
    expect(decoded.some((token) => token.lexeme === "switch" && token.tokenType === "keyword")).toBe(
      true
    );
  });

  it("highlights soft class keywords extends/implements", () => {
    const source =
      "class Map<K, V> extends Base<K> implements Iterable<V> {\n" +
      "  a: K\n" +
      "}\n";
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });
    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.some((token) => token.lexeme === "extends" && token.tokenType === "keyword")).toBe(
      true
    );
    expect(
      decoded.some((token) => token.lexeme === "implements" && token.tokenType === "keyword")
    ).toBe(true);
  });
});
