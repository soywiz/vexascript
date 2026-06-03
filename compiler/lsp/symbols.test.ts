import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { SymbolKind } from "vscode-languageserver/node.js";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { createDocumentSymbols, createWorkspaceSymbols } from "./symbols";

describe("lsp symbols", () => {
  it("builds hierarchical document symbols", () => {
    const source =
      "class Point(val x: int, val y: int) {\n" +
      "  move(dx: int, dy: int) {\n" +
      "    return dx + dy\n" +
      "  }\n" +
      "  get label(): string {\n" +
      "    return \"point\"\n" +
      "  }\n" +
      "}\n" +
      "fun demo() {}\n" +
      "let a = 1\n" +
      "let b = 2, c = 3\n";
    const ast = parseFile(tokenizeReader(source));

    const symbols = createDocumentSymbols(ast);
    expect(symbols.map((symbol) => symbol.name)).toEqual(["Point", "demo", "a", "b", "c"]);
    expect(symbols[0]?.kind).toBe(SymbolKind.Class);
    expect(symbols[0]?.children?.map((child) => child.name)).toEqual(["move", "label"]);
    expect(symbols[0]?.children?.[0]?.kind).toBe(SymbolKind.Method);
    expect(symbols[0]?.children?.[1]?.kind).toBe(SymbolKind.Property);
  });


  it("builds document symbols for exported declarations", () => {
    const ast = parseFile(tokenizeReader(
      "export class Point { move() {} }\n" +
      "export fun demo() {}\n" +
      "export const value = 1\n"
    ));

    const symbols = createDocumentSymbols(ast);
    expect(symbols.map((symbol) => symbol.name)).toEqual(["Point", "demo", "value"]);
    expect(symbols[0]?.children?.map((child) => child.name)).toEqual(["move"]);
  });

  it("finds workspace symbols across source roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-workspace-symbols-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    await writeFile(worldFile, "class MyPoint\nfun buildPoint() {}\n", "utf8");
    await writeFile(helloFile, "let value = 1\n", "utf8");

    const symbols = createWorkspaceSymbols({
      sourceRoots: [root],
      query: "point"
    });

    const names = symbols.map((symbol) => symbol.name);
    expect(names).toEqual(expect.arrayContaining(["MyPoint", "buildPoint"]));

    const point = symbols.find((symbol) => symbol.name === "MyPoint");
    expect(point?.kind).toBe(SymbolKind.Class);
    expect(point?.location.uri).toBe(pathToFileURL(worldFile).toString());
  });
});
