import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { SymbolKind } from "vscode-languageserver/node.js";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { createDocumentSymbols, createWorkspaceSymbols } from "./symbols";

describe("lsp symbols", () => {
  it("builds hierarchical document symbols", async () => {
    const source = dedent`
      class Point(val x: int, val y: int) {
        move(dx: int, dy: int) {
          return dx + dy
        }
        get label(): string {
          return "point"
        }
      }
      interface Drawable {}
      type PointTuple = string
      fun demo() {}
      let a = 1
      let b = 2, c = 3
      `;
    const ast = parseFile(tokenizeReader(source));

    const symbols = createDocumentSymbols(ast);
    expect(symbols.map((symbol) => symbol.name)).toEqual(["Point", "Drawable", "PointTuple", "demo", "a", "b", "c"]);
    expect(symbols[0]?.kind).toBe(SymbolKind.Class);
    expect(symbols[0]?.children?.map((child) => child.name)).toEqual(["move", "label"]);
    expect(symbols[0]?.children?.[0]?.kind).toBe(SymbolKind.Method);
    expect(symbols[0]?.children?.[1]?.kind).toBe(SymbolKind.Property);
    expect(symbols[1]?.kind).toBe(SymbolKind.Interface);
    expect(symbols[2]?.kind).toBe(SymbolKind.Interface);
  });


  it("builds document symbols for exported declarations", async () => {
    const ast = parseFile(tokenizeReader(dedent`
      export class Point { move() {} }
      export fun demo() {}
      export const value = 1
      `
    ));

    const symbols = createDocumentSymbols(ast);
    expect(symbols.map((symbol) => symbol.name)).toEqual(["Point", "demo", "value"]);
    expect(symbols[0]?.children?.map((child) => child.name)).toEqual(["move"]);
  });

  it("finds workspace symbols across source roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-workspace-symbols-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    await writeFile(
      worldFile,
      "class MyPoint\ninterface PointLike {}\ntype PointName = string\nfun buildPoint() {}\n",
      "utf8"
    );
    await writeFile(helloFile, "let value = 1\n", "utf8");

    const symbols = await createWorkspaceSymbols({
      sourceRoots: [root],
      query: "point"
    });

    const names = symbols.map((symbol) => symbol.name);
    expect(names).toEqual(expect.arrayContaining(["MyPoint", "PointLike", "PointName", "buildPoint"]));

    const point = symbols.find((symbol) => symbol.name === "MyPoint");
    expect(point?.kind).toBe(SymbolKind.Class);
    expect(point?.location.uri).toBe(pathToFileURL(worldFile).toString());

    const interfaceSymbol = symbols.find((symbol) => symbol.name === "PointLike");
    expect(interfaceSymbol?.kind).toBe(SymbolKind.Interface);

    const typeSymbol = symbols.find((symbol) => symbol.name === "PointName");
    expect(typeSymbol?.kind).toBe(SymbolKind.Interface);
  });
});
