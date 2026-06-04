import { describe, it } from "node:test";
import { expect } from "../../expect";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { createAnalysisSession } from "./analysisSession";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems
} from "./completion";

describe("createCompletionItemsForPosition", () => {
  it("includes in-scope variables and parameters inside function body", () => {
    const source =
      "let top = 1\n" +
      "fun demo(a, b: int) {\n" +
      "  let inner = a\n" +
      "  return inner\n" +
      "}\n";
    const ast = parseFile(tokenizeReader(source));
    const items = createCompletionItemsForPosition(ast, 3, 3);
    const labels = items.map((item) => item.label);
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(labels).toContain("a");
    expect(labels).toContain("b");
    expect(labels).toContain("inner");
    expect(labels).toContain("top");
    expect(labels).toContain("demo");
    expect(byLabel.get("top")?.detail).toBe("In-scope variable: int");
    expect(byLabel.get("inner")?.detail).toBe("In-scope variable: unknown");
    expect(byLabel.get("b")?.detail).toBe("In-scope parameter: int");
    expect(byLabel.get("demo")?.detail).toBe("In-scope function: (a: unknown, b: int) => unknown");
  });

  it("keeps keyword completions available", () => {
    const labels = createKeywordOnlyCompletionItems().map((item) => item.label);
    expect(labels).toContain("fn");
    expect(labels).toContain("type");
    expect(labels).toContain("interface");
    expect(labels).toContain("namespace");
    expect(labels).toContain("module");
    expect(labels).toContain("declare");
    expect(labels).toContain("int");
    expect(labels).toContain("number");
    expect(labels).toContain("bigint");
    expect(labels).toContain("long");
    expect(labels).toContain("string");
    expect(labels).toContain("boolean");
  });

  it("includes auto-import completion items with additional text edits", () => {
    const source = "fun demo() {\n  return Poi\n}\n";
    const ast = parseFile(tokenizeReader(source));
    const items = createCompletionItemsForPosition(
      ast,
      1,
      12,
      undefined,
      [
        {
          symbol: { name: "Point", filePath: "/tmp/a.my", kind: "class" },
          importPath: "./a",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 }
          }
        }
      ]
    );
    const point = items.find((item) => item.label === "Point");

    expect(point).toBeDefined();
    expect(point?.detail).toBe("Auto import from ./a");
    expect(point?.additionalTextEdits?.[0]?.newText).toBe(
      "import { Point } from \"./a\"\n"
    );
  });

  it("offers exported runtime namespace members for member access", () => {
    const source = "namespace Tools { export const version = 1; const hidden = 2; export function read() { return version } }\nTools.";
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, 1, 6, session.analysis!, [], { text: source });
    expect(items.map((item) => item.label)).toEqual(expect.arrayContaining(["version", "read"]));
    expect(items.map((item) => item.label)).not.toContain("hidden");
  });

  it("offers ECMAScript runtime members for built-in globals", () => {
    const source = "fun demo() {\n  Math.\n}\n";
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, 1, 7, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["abs", "floor", "max", "random"]));
    expect(labels).not.toContain("demo");
  });

  it("resolves member completions from explicitly typed variables", () => {
    const source =
      "fun demo() {\n" +
      "  const result: Point = value\n" +
      "  return result.\n" +
      "}\n" +
      "class Point(val x: int, val y: int)\n";
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, 2, 16, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["x", "y"]));
    expect(labels).not.toEqual(expect.arrayContaining(["result", "value", "true"]));
  });

  it("prioritizes class member completions for member access", () => {
    const source =
      "class Point(val x: int, val y: int) {\n" +
      "  sum() {\n" +
      "    return 0\n" +
      "  }\n" +
      "}\n" +
      "fun demo() {\n" +
      "  const point = new Point(1, 2)\n" +
      "  point.x\n" +
      "}\n";
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();
    const items = createCompletionItemsForPosition(
      session.ast!,
      7,
      8,
      session.analysis!,
      [],
      { text: source }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("x");
    expect(labels).toContain("y");
    expect(labels).toContain("sum");
    expect(labels).not.toContain("demo");
    expect(labels).not.toContain("point");
  });

  it("includes constructor parameter properties in member completion", () => {
    const source =
      "class User { constructor(public id: string, readonly age: int) {} }\n" +
      "let user = new User(\"a\", 1)\n" +
      "user.id\n";
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, 2, 5, session.analysis!, [], { text: source });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("id")?.detail).toBe("Class property: string");
    expect(byLabel.get("age")?.detail).toBe("Class property: int");
  });

  it("resolves member completions for chained member access", () => {
    const source =
      "class Point(val x: int, val y: int)\n" +
      "class Holder(val point: Point)\n" +
      "fun demo() {\n" +
      "  const holder = new Holder(new Point(1, 2))\n" +
      "  holder.point.x\n" +
      "}\n";
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = createCompletionItemsForPosition(
      session.ast!,
      4,
      15,
      session.analysis!,
      [],
      { text: source }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("x");
    expect(labels).toContain("y");
    expect(labels).not.toContain("holder");
  });

  it("resolves specialized generic member types in completion details", () => {
    const source =
      "class Map<K, V> {\n" +
      "  a: K\n" +
      "  b: V\n" +
      "  get(key: K): V { }\n" +
      "}\n" +
      "fun demo() {\n" +
      "  const map = new Map<string, int>()\n" +
      "  map.a\n" +
      "}\n";
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = createCompletionItemsForPosition(
      session.ast!,
      7,
      7,
      session.analysis!,
      [],
      { text: source }
    );
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("a")?.detail).toBe("Class property: string");
  });

  it("includes inherited generic members in completion details", () => {
    const source =
      "class Base<T> {\n" +
      "  value: T\n" +
      "  getValue(): T { }\n" +
      "}\n" +
      "class Child extends Base<string> {\n" +
      "}\n" +
      "fun demo() {\n" +
      "  const child = new Child()\n" +
      "  child.v\n" +
      "  child.g\n" +
      "}\n";
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const valueItems = createCompletionItemsForPosition(
      session.ast!,
      8,
      9,
      session.analysis!,
      [],
      { text: source }
    );
    const valueByLabel = new Map(valueItems.map((item) => [item.label, item]));
    expect(valueByLabel.get("value")?.detail).toBe("Class property: string");

    const methodItems = createCompletionItemsForPosition(
      session.ast!,
      9,
      9,
      session.analysis!,
      [],
      { text: source }
    );
    const methodByLabel = new Map(methodItems.map((item) => [item.label, item]));

    expect(methodByLabel.get("getValue")?.detail).toBe("Class method: () => string");
  });

  it("ranks in-scope symbols by nearest scope distance", () => {
    const source =
      "let top = 1\n" +
      "fun demo() {\n" +
      "  let outer = 2\n" +
      "  {\n" +
      "    let inner = 3\n" +
      "    inn\n" +
      "  }\n" +
      "}\n";
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = createCompletionItemsForPosition(
      session.ast!,
      5,
      7,
      session.analysis!,
      [],
      { text: source }
    );
    const symbolLabels = items
      .filter((item) => item.detail?.startsWith("In-scope "))
      .map((item) => item.label);

    expect(symbolLabels.indexOf("inner")).toBeLessThan(symbolLabels.indexOf("outer"));
    expect(symbolLabels.indexOf("outer")).toBeLessThan(symbolLabels.indexOf("top"));
  });

  it("ranks call-argument completions by expected parameter type relevance", () => {
    const source =
      "fun takesNumber(value: number) {\n" +
      "}\n" +
      "fun demo() {\n" +
      "  let exact: number = 2\n" +
      "  let count: int = 1\n" +
      "  let text: string = \"a\"\n" +
      "  takesNumber(ex)\n" +
      "}\n";
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = createCompletionItemsForPosition(
      session.ast!,
      6,
      14,
      session.analysis!,
      [],
      { text: source }
    );
    const symbolLabels = items
      .filter((item) => item.detail?.startsWith("In-scope "))
      .map((item) => item.label);

    expect(symbolLabels.indexOf("exact")).toBeLessThan(symbolLabels.indexOf("count"));
    expect(symbolLabels.indexOf("count")).toBeLessThan(symbolLabels.indexOf("text"));
  });
});
