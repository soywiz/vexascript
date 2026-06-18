import { Analysis } from "compiler/analysis/Analysis";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import {
  createSemanticTokens,
  DEPRECATED_TOKEN_MODIFIER,
  semanticTokenRangeKey,
  VEXA_SEMANTIC_TOKENS_LEGEND
} from "./semanticTokens";

interface DecodedToken {
  line: number;
  character: number;
  length: number;
  tokenType: string;
  tokenModifiers: string[];
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
    const tokenType = VEXA_SEMANTIC_TOKENS_LEGEND.tokenTypes[tokenTypeIndex] ?? "unknown";
    const tokenModifierBits = data[i + 4]!;
    const tokenModifiers = VEXA_SEMANTIC_TOKENS_LEGEND.tokenModifiers.filter((_, index) =>
      (tokenModifierBits & (1 << index)) !== 0
    );
    const lineText = lines[line] ?? "";
    const lexeme = lineText.slice(character, character + length);
    decoded.push({
      line,
      character,
      length,
      tokenType,
      tokenModifiers,
      lexeme
    });
  }

  return decoded;
}

describe("semantic tokens", () => {
  it("highlights debugger as a keyword", () => {
    const source = "debugger\n";
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });

    const decoded = decodeTokens(source, semantic.data);
    expect(decoded.some((token) => token.lexeme === "debugger" && token.tokenType === "keywordControl")).toBe(true);
  });

  it("highlights constructor parameter properties as properties", () => {
    const source = "class User { constructor(public readonly id: string, age: int) {} }\n";
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({ text: source, ast: session.ast, analysis: session.analysis });
    const decoded = decodeTokens(source, semantic.data);
    const id = decoded.find((token) => token.lexeme === "id");
    const age = decoded.find((token) => token.lexeme === "age");

    expect(id?.tokenType).toBe("property");
    expect(age?.tokenType).toBe("parameter");
  });

  it("highlights angle-bracket assertion type names", () => {
    const source = "let value = <Point>raw\n";
    // Angle-bracket casts are TypeScript-only (VexaScript reserves `<...>` for JSX).
    const ast = parseFile(tokenizeReader(source, { jsx: false }), { language: "typescript" });
    const analysis = new Analysis(ast);
    const semantic = createSemanticTokens({
      text: source,
      ast,
      analysis
    });

    const decoded = decodeTokens(source, semantic.data);
    expect(decoded.some((token) => token.lexeme === "Point" && token.tokenType === "type")).toBe(true);
  });

  it("splits semantic keyword families for declarations, callables, types, and control flow", () => {
    const source = dedent`
      declare class Console {
        log(a: number)
      }
      declare var console: Console
      type Element<T> = T extends (infer U)[] ? U : keyof T
      switch (new Console()) {
        case console:
          break
        default:
          break
      }
      `;

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

    expect(byPosition.get("0:0")).toBe("keywordType");
    expect(byPosition.get("0:8")).toBe("keywordType");
    expect(byPosition.get("3:0")).toBe("keywordType");
    expect(byPosition.get("3:8")).toBe("keywordModifier");
    expect(decoded.some((token) => token.lexeme === "infer" && token.tokenType === "keywordType")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "keyof" && token.tokenType === "keywordType")).toBe(true);
    expect(byPosition.get("5:0")).toBe("keywordControl");
    expect(byPosition.get("5:8")).toBe("keywordControl");
    expect(byPosition.get("6:2")).toBe("keywordControl");
    expect(byPosition.get("8:2")).toBe("keywordControl");
  });

  it("highlights class modifiers as keywords so semantic tokens do not gray them out", () => {
    const source = dedent`
      class Demo {
        static var answer = 42
        private val id: string
      }
      `;
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });

    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.some((token) => token.lexeme === "static" && token.tokenType === "keywordModifier")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "private" && token.tokenType === "keywordModifier")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "val" && token.tokenType === "keywordModifier")).toBe(true);
  });

  it("highlights operators and primitive literals", () => {
    const source = "let a: int = 1 + 2\na += 3\nlet re = /a+/g\n";
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
    expect(decoded.some((token) => token.lexeme === "/a+/g" && token.tokenType === "string")).toBe(
      true
    );
  });

  it("highlights chain expression members like ordinary member accesses", () => {
    const source = dedent`
      class View {
        addTo(stage: any) {}
      }
      val view = View()
        ..addTo(stage)
        ..point = 1
      `;
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });
    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.some((token) => token.lexeme === ".." && token.tokenType === "operator")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "addTo" && token.tokenType === "method")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "point" && token.tokenType === "property")).toBe(true);
  });

  it("highlights object methods and their parameters", () => {
    const source = "let obj = { add(a: number): number { return a } }\n";
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });
    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.some((token) => token.lexeme === "add" && token.tokenType === "method")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "a" && token.tokenType === "parameter")).toBe(true);
  });

  it("highlights expanded import bindings", () => {
    const source = dedent`
      import React, { useState as useLocalState } from "react"
      import * as fs from "fs"
      `;
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });
    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.some((token) => token.lexeme === "React" && token.tokenType === "variable")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "useState" && token.tokenType === "variable")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "useLocalState" && token.tokenType === "variable")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "fs" && token.tokenType === "namespace")).toBe(true);
  });

  it("highlights constructor calls, methods, properties, and type-only imports distinctly", () => {
    const source = dedent`
      import { Application, Graphics, type Point } from "pixi.js"

      val app = Application()
      await app.init({ width: 480 })
      app.renderer.resize(width, height)
      val badge = new Graphics()
      badge.position = app.stage
      stage.addChild(badge)
      `;
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });
    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.some((token) => token.lexeme === "Application" && token.tokenType === "class")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "Graphics" && token.tokenType === "class")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "Point" && token.tokenType === "type")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "init" && token.tokenType === "method")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "renderer" && token.tokenType === "property")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "resize" && token.tokenType === "method")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "position" && token.tokenType === "property")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "addChild" && token.tokenType === "method")).toBe(true);
  });

  it("emits deprecated token modifiers for matching token ranges", () => {
    const source = "value.oldMethod()\n";
    const session = createAnalysisSession(source);
    const deprecatedRangeKey = semanticTokenRangeKey({
      start: { offset: "value.".length, line: 0, column: "value.".length },
      end: { offset: "value.oldMethod".length, line: 0, column: "value.oldMethod".length }
    });
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      tokenModifiersByRangeKey: new Map([[deprecatedRangeKey, DEPRECATED_TOKEN_MODIFIER]])
    });
    const decoded = decodeTokens(source, semantic.data);
    const token = decoded.find((item) => item.lexeme === "oldMethod");

    expect(VEXA_SEMANTIC_TOKENS_LEGEND.tokenModifiers).toEqual(["deprecated"]);
    expect(token?.tokenModifiers).toContain("deprecated");
  });

  it("highlights ambient namespace paths and parsed body declarations", () => {
    const source = "declare namespace Company.Tools {\nexport const version: string;\n}";
    const ast = parseFile(tokenizeReader(source), { language: "typescript" });
    const semantic = createSemanticTokens({ text: source, ast, analysis: new Analysis(ast) });
    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.filter((token) => token.tokenType === "namespace").map((token) => token.lexeme)).toEqual(["Company", "Tools"]);
    expect(decoded.some((token) => token.lexeme === "version" && token.tokenType === "variable")).toBe(true);
  });

  it("highlights exported ambient declarations", () => {
    const source = "declare type Id = string;\nexport declare function read(id: Id): Id;";
    const ast = parseFile(tokenizeReader(source), { language: "typescript" });
    const semantic = createSemanticTokens({ text: source, ast, analysis: new Analysis(ast) });
    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.some((token) => token.lexeme === "Id" && token.tokenType === "type")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "read" && token.tokenType === "function")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "id" && token.tokenType === "parameter")).toBe(true);
  });

  it("highlights export-as-namespace names as namespaces", () => {
    const source = "export as namespace MyLib\n";
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });
    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.some((token) => token.lexeme === "MyLib" && token.tokenType === "namespace")).toBe(true);
  });

  it("supports range requests", () => {
    const source = dedent`
      switch (a) {
        case 1:
          break
        default:
          break
      }
      `;

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
    const source = dedent`
      asdsa declare class Console {
      declare var console: Console
      switch (new Console()) {
      `;
    const session = createAnalysisSession(source);

    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });
    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.some((token) => token.lexeme === "declare" && token.tokenType === "keywordType")).toBe(
      true
    );
    expect(decoded.some((token) => token.lexeme === "class" && token.tokenType === "keywordType")).toBe(
      true
    );
    expect(decoded.some((token) => token.lexeme === "switch" && token.tokenType === "keywordControl")).toBe(
      true
    );
  });

  it("highlights soft class keywords extends/implements/override", () => {
    const source = dedent`
      class Map<K, V> extends Base<K> implements Iterable<V> {
        override a: K
        a: K
      }
      `;
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });
    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.some((token) => token.lexeme === "extends" && token.tokenType === "keywordType")).toBe(
      true
    );
    expect(
      decoded.some((token) => token.lexeme === "implements" && token.tokenType === "keywordType")
    ).toBe(true);
    expect(
      decoded.some((token) => token.lexeme === "override" && token.tokenType === "keywordType")
    ).toBe(true);
  });

  it("highlights interface as keyword", () => {
    const source = dedent`
      interface Readable {
        say(): number
      }
      `;
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });
    const decoded = decodeTokens(source, semantic.data);

    expect(
      decoded.some((token) => token.lexeme === "interface" && token.tokenType === "keywordType")
    ).toBe(true);
  });

  it("highlights fun/function separately from class/interface keywords", () => {
    const source = dedent`
      class Demo {
        fun update(): void {
        }
      }
      `;
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis
    });
    const decoded = decodeTokens(source, semantic.data);

    expect(decoded.some((token) => token.lexeme === "class" && token.tokenType === "keywordType")).toBe(true);
    expect(decoded.some((token) => token.lexeme === "fun" && token.tokenType === "keywordFunction")).toBe(true);
  });
  it("highlights identifiers introduced by destructuring as variables", () => {
    const source = "let { source :: target, nested :: { value }, ...rest } = input\nconst [first, , ...tail] = values";
    const session = createAnalysisSession(source);
    const semantic = createSemanticTokens({ text: source, ast: session.ast, analysis: session.analysis });
    const decoded = decodeTokens(source, semantic.data);

    for (const name of ["target", "value", "rest", "first", "tail"]) {
      expect(decoded.some((token) => token.lexeme === name && token.tokenType === "variable")).toBe(true);
    }
    expect(decoded.some((token) => token.lexeme === "source" && token.tokenType === "property")).toBe(true);
  });

});

describe("destructured parameter semantic tokens", () => {
  it("highlights introduced names as parameters and property keys as properties", () => {
    const source = "function unpack({ source :: target, nested :: { value }, ...rest }, [first, , ...tail]) { return target }";
    const session = createAnalysisSession(source);
    const decoded = decodeTokens(source, createSemanticTokens({ text: source, ast: session.ast, analysis: session.analysis }).data);
    for (const name of ["target", "value", "rest", "first", "tail"]) {
      expect(decoded.some((token) => token.lexeme === name && token.tokenType === "parameter")).toBe(true);
    }
    expect(decoded.some((token) => token.lexeme === "source" && token.tokenType === "property")).toBe(true);
  });
});
