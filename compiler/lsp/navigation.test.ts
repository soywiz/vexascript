import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { Analysis } from "compiler/analysis/Analysis";
import {
  createDefinitionLocation,
  createHover,
  createPrepareRename,
  createReferences,
  createRenameWorkspaceEdit
} from "./navigation";

const URI = "file:///demo.my";

function analysisOf(source: string): Analysis {
  const ast = parseFile(tokenizeReader(source));
  return new Analysis(ast);
}

describe("lsp navigation", () => {
  it("resolves go-to-definition for variable usage", () => {
    const source = "let value = 1\nfun demo() {\n  let local = value\n  return local\n}\n";
    const analysis = analysisOf(source);

    const location = createDefinitionLocation(analysis, URI, 2, 16);
    expect(location).toEqual({
      uri: URI,
      range: {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 9 }
      }
    });
  });

  it("provides hover info for symbols and expressions", () => {
    const source = "let value = 1 + 2\n";
    const analysis = analysisOf(source);

    const symbolHover = createHover(analysis, 0, 5);
    expect(symbolHover?.contents).toEqual({
      kind: "plaintext",
      value: "variable value: int"
    });

    const expressionHover = createHover(analysis, 0, 12);
    expect(expressionHover?.contents).toEqual({
      kind: "plaintext",
      value: "expression: int"
    });
  });

  it("provides class type hover for new expressions", () => {
    const source = "class Point\nlet p = new Point()\n";
    const analysis = analysisOf(source);

    const expressionHover = createHover(analysis, 1, 9);
    expect(expressionHover?.contents).toEqual({
      kind: "plaintext",
      value: "expression: Point"
    });
  });

  it("provides hover info for angle-bracket assertion expressions", () => {
    const source = "let p = <string>value\n";
    const analysis = analysisOf(source);

    const expressionHover = createHover(analysis, 0, 9);
    expect(expressionHover?.contents).toEqual({
      kind: "plaintext",
      value: "expression: string"
    });
  });

  it("provides specialized generic type hover for inferred variables", () => {
    const source = "class Map<K, V> { a: K }\nfun demo() {\n  const map = new Map<string, int>()\n}\n";
    const analysis = analysisOf(source);

    const symbolHover = createHover(analysis, 2, 8);
    expect(symbolHover?.contents).toEqual({
      kind: "plaintext",
      value: "variable map: Map<string, int>"
    });
  });

  it("provides hover and definition for operator uses that resolve to class overloads", () => {
    const source = dedent`
      class Point(val x: number, val y: number) {
        operator+(other: Point): Point {
          return new Point(this.x + other.x, this.y + other.y)
        }
      }
      fun demo() {
        let p = new Point(1, 2)
        let q = new Point(3, 4)
        let r = p + q
      }
      `;
    const analysis = analysisOf(source);

    const hover = createHover(analysis, 8, 12);
    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "method operator+: (other: Point) => Point"
    });
    expect(hover?.range).toEqual({
      start: { line: 8, character: 12 },
      end: { line: 8, character: 13 }
    });

    const definition = createDefinitionLocation(analysis, URI, 8, 12);
    expect(definition).toEqual({
      uri: URI,
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 11 }
      }
    });
  });

  it("provides hover and definition for extension operator uses", () => {
    const source = dedent`
      class Point(val x: number, val y: number)
      fun Point.operator+(other: Point): Point {
        return new Point(this.x + other.x, this.y + other.y)
      }
      fun demo() {
        let p = new Point(1, 2)
        let q = new Point(3, 4)
        let r = p + q
      }
      `;
    const analysis = analysisOf(source);

    const hover = createHover(analysis, 7, 12);
    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "function operator+: (other: Point) => Point"
    });
    expect(hover?.range).toEqual({
      start: { line: 7, character: 12 },
      end: { line: 7, character: 13 }
    });

    const definition = createDefinitionLocation(analysis, URI, 7, 12);
    expect(definition).toEqual({
      uri: URI,
      range: {
        start: { line: 1, character: 10 },
        end: { line: 1, character: 19 }
      }
    });
  });

  it("supports prepare rename and rename workspace edits", () => {
    const source = "fun demo() {\n  let local = 1\n  return local\n}\n";
    const analysis = analysisOf(source);

    const prepare = createPrepareRename(analysis, 1, 7);
    expect(prepare).toEqual({
      range: {
        start: { line: 1, character: 6 },
        end: { line: 1, character: 11 }
      },
      placeholder: "local"
    });

    const rename = createRenameWorkspaceEdit(analysis, URI, 1, 7, "renamed");
    expect(rename).toEqual({
      changes: {
        [URI]: [
          {
            range: {
              start: { line: 1, character: 6 },
              end: { line: 1, character: 11 }
            },
            newText: "renamed"
          },
          {
            range: {
              start: { line: 2, character: 9 },
              end: { line: 2, character: 14 }
            },
            newText: "renamed"
          }
        ]
      }
    });
  });

  it("returns references including declaration", () => {
    const source =
      "let value = 1\nfun demo() {\n  let local = value\n  return value + local\n}\n";
    const analysis = analysisOf(source);

    const references = createReferences(analysis, URI, 2, 16, true);
    expect(references).toEqual([
      {
        uri: URI,
        range: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 9 }
        }
      },
      {
        uri: URI,
        range: {
          start: { line: 2, character: 14 },
          end: { line: 2, character: 19 }
        }
      },
      {
        uri: URI,
        range: {
          start: { line: 3, character: 9 },
          end: { line: 3, character: 14 }
        }
      }
    ]);
  });

  it("returns references without declaration when requested", () => {
    const source =
      "let value = 1\nfun demo() {\n  let local = value\n  return value + local\n}\n";
    const analysis = analysisOf(source);

    const references = createReferences(analysis, URI, 2, 16, false);
    expect(references).toEqual([
      {
        uri: URI,
        range: {
          start: { line: 2, character: 14 },
          end: { line: 2, character: 19 }
        }
      },
      {
        uri: URI,
        range: {
          start: { line: 3, character: 9 },
          end: { line: 3, character: 14 }
        }
      }
    ]);
  });

  it("returns empty references when there is no symbol", () => {
    const source = "let value = 1\n";
    const analysis = analysisOf(source);

    expect(createReferences(analysis, URI, 0, 0, true)).toEqual([]);
  });

  it("does not allow rename for builtin symbols", () => {
    const source = "let a = true\n";
    const analysis = analysisOf(source);

    expect(createPrepareRename(analysis, 0, 9)).toBeNull();
    expect(createRenameWorkspaceEdit(analysis, URI, 0, 9, "yes")).toBeNull();
  });
});
