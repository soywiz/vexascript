import { describe, expect, it } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { Analysis } from "compiler/analysis/Analysis";
import {
  createDefinitionLocation,
  createHover,
  createPrepareRename,
  resolveCursorTarget,
  createReferences,
  createRenameWorkspaceEdit
} from "./navigation";

const URI = "file:///demo.vx";

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

  it("provides hover and definition for parameter references inside documentation comments", () => {
    const marked = sourceWithCursor(dedent`
      /// Returns the distance between two points.
      /// [^^^a] and [b] must be in the same coordinate space.
      fun distance(a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
    `);
    const ast = parseFile(tokenizeReader(marked.source));
    const analysis = new Analysis(ast);

    const hover = createHover(analysis, marked.line, marked.character, ast);
    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "parameter a: Point"
    });
    expect(hover?.range).toEqual({
      start: { line: 1, character: 5 },
      end: { line: 1, character: 6 }
    });

    const definition = createDefinitionLocation(analysis, URI, marked.line, marked.character, ast);
    expect(definition).toEqual({
      uri: URI,
      range: {
        start: { line: 2, character: 13 },
        end: { line: 2, character: 14 }
      }
    });
  });

  it("provides hover and definition for JSX component attributes declared by destructured props", () => {
    const marked = sourceWithCursor(dedent`
      function Page({ name: string }) {
        return <h1>{name}</h1>
      }

      const html = <Page ^^^name="Carlos" />
    `);
    const ast = parseFile(tokenizeReader(marked.source, { jsx: true }));
    const analysis = new Analysis(ast);

    const hover = createHover(analysis, marked.line, marked.character);
    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "parameter name: string"
    });
    expect(hover?.range).toEqual({
      start: { line: 4, character: 19 },
      end: { line: 4, character: 23 }
    });

    const definition = createDefinitionLocation(analysis, URI, marked.line, marked.character);
    expect(definition).toEqual({
      uri: URI,
      range: {
        start: { line: 0, character: 16 },
        end: { line: 0, character: 20 }
      }
    });
  });

  it("goes to the declared prop name for renamed JSX destructured props", () => {
    const marked = sourceWithCursor(dedent`
      function Page({ name :: displayName: string }) {
        return <h1>{displayName}</h1>
      }

      const html = <Page ^^^name="Carlos" />
    `);
    const ast = parseFile(tokenizeReader(marked.source, { jsx: true }));
    const analysis = new Analysis(ast);

    const definition = createDefinitionLocation(analysis, URI, marked.line, marked.character);
    expect(definition).toEqual({
      uri: URI,
      range: {
        start: { line: 0, character: 16 },
        end: { line: 0, character: 20 }
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

  it("reports member access on 'any' as expression type 'any'", () => {
    const source = dedent`
      fun demo(props: any) {
        return props.style
      }
      `;
    const analysis = analysisOf(source);

    const hover = createHover(analysis, 1, 18);
    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "expression: any"
    });
  });

  it("normalizes cursor positions through the shared cursor target resolver", () => {
    const source = "let value = 1\n";
    const analysis = analysisOf(source);

    const target = resolveCursorTarget(analysis, 0, 9);
    expect(target?.kind).toBe("analysis");
    expect(target?.character).toBe(9);

    const hover = createHover(analysis, 0, 9);
    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "variable value: int"
    });
  });


  it("provides hover and definition for annotation applications", () => {
    const marked = sourceWithCursor(dedent`
      annotation JsName(val name: string)

      @^^^JsName("renamed")
      fun demo() {}
    `);
    const ast = parseFile(tokenizeReader(marked.source));
    const analysis = new Analysis(ast);

    const hover = createHover(analysis, marked.line, marked.character, ast);
    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "annotation JsName(val name: string)"
    });
    expect(hover?.range).toEqual({
      start: { line: 2, character: 1 },
      end: { line: 2, character: 7 }
    });

    const definition = createDefinitionLocation(analysis, URI, marked.line, marked.character, ast);
    expect(definition).toEqual({
      uri: URI,
      range: {
        start: { line: 0, character: 11 },
        end: { line: 0, character: 17 }
      }
    });
  });

  it("supports references and rename for annotation declarations and uses", () => {
    const marked = sourceWithCursor(dedent`
      annotation ^^^DemoTag(val label: string)
      @DemoTag("hello")
      @DemoTag("bye")
      fun demo() {}
    `);
    const ast = parseFile(tokenizeReader(marked.source));
    const analysis = new Analysis(ast);

    expect(createPrepareRename(analysis, marked.line, marked.character, ast)).toEqual({
      range: {
        start: { line: 0, character: 11 },
        end: { line: 0, character: 18 }
      },
      placeholder: "DemoTag"
    });
    expect(createReferences(analysis, URI, marked.line, marked.character, true, ast)).toEqual([
      {
        uri: URI,
        range: {
          start: { line: 0, character: 11 },
          end: { line: 0, character: 18 }
        }
      },
      {
        uri: URI,
        range: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 8 }
        }
      },
      {
        uri: URI,
        range: {
          start: { line: 2, character: 1 },
          end: { line: 2, character: 8 }
        }
      }
    ]);
    expect(createRenameWorkspaceEdit(analysis, URI, marked.line, marked.character, "DemoLabel", ast)).toEqual({
      changes: {
        [URI]: [
          {
            range: {
              start: { line: 0, character: 11 },
              end: { line: 0, character: 18 }
            },
            newText: "DemoLabel"
          },
          {
            range: {
              start: { line: 1, character: 1 },
              end: { line: 1, character: 8 }
            },
            newText: "DemoLabel"
          },
          {
            range: {
              start: { line: 2, character: 1 },
              end: { line: 2, character: 8 }
            },
            newText: "DemoLabel"
          }
        ]
      }
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
    // Angle-bracket casts are TypeScript-only (VexaScript reserves `<...>` for JSX).
    const ast = parseFile(tokenizeReader(source, { jsx: false }), { language: "typescript" });
    const analysis = new Analysis(ast);

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

  it("provides hover and definition for property reference fields", () => {
    const marked = sourceWithCursor(dedent`
      class View(var x: number)
      val view = View(1)
      val ref = view::^^^x
    `);
    const ast = parseFile(tokenizeReader(marked.source));
    const analysis = new Analysis(ast);

    expect(createHover(analysis, marked.line, marked.character, ast)?.contents).toEqual({
      kind: "plaintext",
      value: "variable x: number"
    });

    expect(createDefinitionLocation(analysis, URI, marked.line, marked.character, ast)).toEqual({
      uri: URI,
      range: {
        start: { line: 0, character: 15 },
        end: { line: 0, character: 16 }
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

  it("includes documentation parameter references in find references and rename", () => {
    const marked = sourceWithCursor(dedent`
      /// [a] is the start point.
      /// [^^^a] must be in the same coordinate space as [b].
      fun distance(a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
    `);
    const ast = parseFile(tokenizeReader(marked.source));
    const analysis = new Analysis(ast);

    expect(createPrepareRename(analysis, marked.line, marked.character, ast)).toEqual({
      range: {
        start: { line: 1, character: 5 },
        end: { line: 1, character: 6 }
      },
      placeholder: "a"
    });

    expect(createReferences(analysis, URI, 2, 13, true, ast)).toEqual([
      {
        uri: URI,
        range: {
          start: { line: 2, character: 13 },
          end: { line: 2, character: 14 }
        }
      },
      {
        uri: URI,
        range: {
          start: { line: 2, character: 55 },
          end: { line: 2, character: 56 }
        }
      },
      {
        uri: URI,
        range: {
          start: { line: 2, character: 66 },
          end: { line: 2, character: 67 }
        }
      },
      {
        uri: URI,
        range: {
          start: { line: 0, character: 5 },
          end: { line: 0, character: 6 }
        }
      },
      {
        uri: URI,
        range: {
          start: { line: 1, character: 5 },
          end: { line: 1, character: 6 }
        }
      }
    ]);

    expect(createRenameWorkspaceEdit(analysis, URI, marked.line, marked.character, "start", ast)).toEqual({
      changes: {
        [URI]: [
          {
            range: {
              start: { line: 2, character: 13 },
              end: { line: 2, character: 14 }
            },
            newText: "start"
          },
          {
            range: {
              start: { line: 2, character: 55 },
              end: { line: 2, character: 56 }
            },
            newText: "start"
          },
          {
            range: {
              start: { line: 2, character: 66 },
              end: { line: 2, character: 67 }
            },
            newText: "start"
          },
          {
            range: {
              start: { line: 0, character: 5 },
              end: { line: 0, character: 6 }
            },
            newText: "start"
          },
          {
            range: {
              start: { line: 1, character: 5 },
              end: { line: 1, character: 6 }
            },
            newText: "start"
          }
        ]
      }
    });
  });

  it("supports rename, hover, and definition for class members", () => {
    const source = dedent`
      class Counter(var value: int) {
        increment(): int => value
      }

      val counter = Counter(41)
      counter.increment()
    `;
    const analysis = analysisOf(source);

    expect(createPrepareRename(analysis, 0, 18)).toEqual({
      range: {
        start: { line: 0, character: 18 },
        end: { line: 0, character: 23 }
      },
      placeholder: "value"
    });

    expect(createPrepareRename(analysis, 1, 2)).toEqual({
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 11 }
      },
      placeholder: "increment"
    });

    expect(createHover(analysis, 5, 9)?.contents).toEqual({
      kind: "plaintext",
      value: "method increment: () => int"
    });

    expect(createDefinitionLocation(analysis, URI, 5, 9)).toEqual({
      uri: URI,
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 11 }
      }
    });

    expect(createRenameWorkspaceEdit(analysis, URI, 5, 9, "next")).toEqual({
      changes: {
        [URI]: [
          {
            range: {
              start: { line: 1, character: 2 },
              end: { line: 1, character: 11 }
            },
            newText: "next"
          },
          {
            range: {
              start: { line: 5, character: 8 },
              end: { line: 5, character: 17 }
            },
            newText: "next"
          }
        ]
      }
    });
  });

  it("supports references and rename for enum members at call sites", () => {
    const source = dedent`
      enum Direction { Up, Down }
      let direction = Direction.Up
      let again = Direction.Up
    `;
    const analysis = analysisOf(source);

    expect(createReferences(analysis, URI, 1, 26, true)).toEqual([
      {
        uri: URI,
        range: {
          start: { line: 0, character: 17 },
          end: { line: 0, character: 19 }
        }
      },
      {
        uri: URI,
        range: {
          start: { line: 1, character: 26 },
          end: { line: 1, character: 28 }
        }
      },
      {
        uri: URI,
        range: {
          start: { line: 2, character: 22 },
          end: { line: 2, character: 24 }
        }
      }
    ]);

    expect(createRenameWorkspaceEdit(analysis, URI, 1, 26, "North")).toEqual({
      changes: {
        [URI]: [
          {
            range: {
              start: { line: 0, character: 17 },
              end: { line: 0, character: 19 }
            },
            newText: "North"
          },
          {
            range: {
              start: { line: 1, character: 26 },
              end: { line: 1, character: 28 }
            },
            newText: "North"
          },
          {
            range: {
              start: { line: 2, character: 22 },
              end: { line: 2, character: 24 }
            },
            newText: "North"
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

  it("includes triple-slash documentation in local hover", () => {
    const marked = sourceWithCursor(dedent`
      /// Greets a person by name.
      fun ^^^greet(name: string): string => "Hello, " + name
    `);
    const ast = parseFile(tokenizeReader(marked.source));
    const analysis = new Analysis(ast);

    const hover = createHover(analysis, marked.line, marked.character, ast);
    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "function greet: (name: string) => string\n\nGreets a person by name."
    });
  });

  it("omits documentation from local hover when none is present", () => {
    const marked = sourceWithCursor(dedent`
      fun ^^^greet(name: string): string => "Hello, " + name
    `);
    const ast = parseFile(tokenizeReader(marked.source));
    const analysis = new Analysis(ast);

    const hover = createHover(analysis, marked.line, marked.character, ast);
    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "function greet: (name: string) => string"
    });
  });
});
