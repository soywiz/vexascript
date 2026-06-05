import { describe, it } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "../test/expect";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { createAnalysisSession } from "./analysisSession";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems
} from "./completion";

function sourceWithCursor(source: string): {
  source: string;
  line: number;
  character: number;
} {
  const marker = "^^^";
  const offset = source.indexOf(marker);
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(marker, offset + marker.length)).toBe(-1);

  const cleanSource = source.slice(0, offset) + source.slice(offset + marker.length);
  const beforeCursor = source.slice(0, offset);
  const lines = beforeCursor.split("\n");

  return {
    source: cleanSource,
    line: lines.length - 1,
    character: lines[lines.length - 1]?.length ?? 0
  };
}

describe("createCompletionItemsForPosition", () => {
  it("includes in-scope variables and parameters inside function body", () => {
    const { source, line, character } = sourceWithCursor(
      "let top = 1\n" +
      "fun demo(a, b: int) {\n" +
      "  let inner = a\n" +
      "  ^^^return inner\n" +
      "}\n"
    );
    const ast = parseFile(tokenizeReader(source));
    const items = createCompletionItemsForPosition(ast, line, character);
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
    const { source, line, character } = sourceWithCursor("fun demo() {\n  return ^^^Poi\n}\n");
    const ast = parseFile(tokenizeReader(source));
    const items = createCompletionItemsForPosition(
      ast,
      line,
      character,
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
    const { source, line, character } = sourceWithCursor(
      "namespace Tools { export const version = 1; const hidden = 2; export function read() { return version } }\nTools.^^^"
    );
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    expect(items.map((item) => item.label)).toEqual(expect.arrayContaining(["version", "read"]));
    expect(items.map((item) => item.label)).not.toContain("hidden");
  });

  it("offers ECMAScript runtime members for built-in globals", () => {
    const { source, line, character } = sourceWithCursor("fun demo() {\n  Math.^^^\n}\n");
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["abs", "floor", "max", "random"]));
    expect(labels).not.toContain("demo");
  });

  it("offers local extension members for numeric literal member access", () => {
    const { source, line, character } = sourceWithCursor(
      "class TimeSpan(val ms: number)\n" +
      "val number.milliseconds => TimeSpan(this)\n" +
      "val number.seconds => TimeSpan(this * 1000)\n" +
      "10.^^^\n"
    );
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["milliseconds", "seconds"]));
  });

  it("offers auto-imported extension members for numeric literal member access", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-completion-"));
    const durationFile = join(root, "duration.my");
    const consumerFile = join(root, "consumer.my");
    await writeFile(
      durationFile,
      "class TimeSpan(val ms: number)\n" +
        "export val number.milliseconds => TimeSpan(this)\n" +
        "export val number.seconds => TimeSpan(this * 1000)\n",
      "utf8"
    );
    const { source, line, character } = sourceWithCursor("10.^^^\n");
    await writeFile(consumerFile, source, "utf8");

    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(consumerFile).toString(),
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => {
        if (filePath === durationFile) {
          return createAnalysisSession(
            "class TimeSpan(val ms: number)\n" +
              "export val number.milliseconds => TimeSpan(this)\n" +
              "export val number.seconds => TimeSpan(this * 1000)\n"
          );
        }
        return filePath === consumerFile ? session : null;
      }
    });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("milliseconds")?.detail).toBe("Auto import extension from ./duration");
    expect(byLabel.get("milliseconds")?.additionalTextEdits?.[0]?.newText).toBe(
      "import { milliseconds } from \"./duration\"\n"
    );
    expect(byLabel.get("seconds")?.detail).toBe("Auto import extension from ./duration");
  });

  it("resolves chained members after extension properties", () => {
    const { source, line, character } = sourceWithCursor(
      "class TimeSpan(val ms: number)\n" +
      "val number.seconds => TimeSpan(this * 1000)\n" +
      "10.seconds.^^^\n"
    );
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("ms");
  });

  it("offers constructor properties inside template interpolation", () => {
    const source =
      "class TimeSpan(val ms: number) {\n" +
      "  toString() => `${m}`\n" +
      "}\n";
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, 1, 20, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels[0]).toBe("ms");
    expect(labels).toContain("this");
  });

  it("offers constructor properties inside empty template interpolation", () => {
    const source =
      "class TimeSpan(val ms: number) {\n" +
      "  toString() => `${}`\n" +
      "}\n";
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, 1, 18, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels[0]).toBe("ms");
    expect(labels).toContain("this");
  });

  it("resolves member completions from explicitly typed variables", () => {
    const { source, line, character } = sourceWithCursor(
      "fun demo() {\n" +
      "  const result: Point = value\n" +
      "  return result.^^^\n" +
      "}\n" +
      "class Point(val x: int, val y: int)\n"
    );
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["x", "y"]));
    expect(labels).not.toEqual(expect.arrayContaining(["result", "value", "true"]));
  });

  it("prioritizes class member completions for member access", () => {
    const { source, line, character } = sourceWithCursor(
      "class Point(val x: int, val y: int) {\n" +
      "  sum() {\n" +
      "    return 0\n" +
      "  }\n" +
      "}\n" +
      "fun demo() {\n" +
      "  const point = new Point(1, 2)\n" +
      "  point.^^^x\n" +
      "}\n"
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();
    const items = createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
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
    const { source, line, character } = sourceWithCursor(
      "class User { constructor(public id: string, readonly age: int) {} }\n" +
      "let user = new User(\"a\", 1)\n" +
      "user.^^^id\n"
    );
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("id")?.detail).toBe("Class property: string");
    expect(byLabel.get("age")?.detail).toBe("Class property: int");
  });

  it("prioritizes primary constructor properties ahead of methods in member completion", () => {
    const { source, line, character } = sourceWithCursor(
      "class Point(val x: number, val y: number) {\n" +
      "  operator+(other: Point): Point => Point(x + other.x, y + other.y)\n" +
      "  operator*(scale: number): Point => Point(x * scale, y * scale)\n" +
      "}\n" +
      "fun demo(point: Point) {\n" +
      "  point.^^^\n" +
      "}\n"
    );
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels.slice(0, 2)).toEqual(["x", "y"]);
  });

  it("keeps operator member completions visible and edits member access safely", () => {
    const { source, line, character } = sourceWithCursor(
      "class Point(val x: number, val y: number) {\n" +
      "  operator+(other: Point): Point => Point(x + other.x, y + other.y)\n" +
      "  operator*(scale: number): Point => Point(x * scale, y * scale)\n" +
      "}\n" +
      "fun demo(point: Point) {\n" +
      "  point.^^^\n" +
      "}\n"
    );
    const session = createAnalysisSession(source);
    const items = createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);
    const operatorItem = items.find((item) => item.label === "operator*");

    expect(labels).toContain("operator+");
    expect(labels).toContain("operator*");
    expect(operatorItem?.filterText).toBe("operator*");
    expect(operatorItem?.textEdit).toEqual({
      range: {
        start: { line, character },
        end: { line, character }
      },
      newText: " * "
    });
    expect(operatorItem?.additionalTextEdits).toEqual([
      {
        range: {
          start: { line, character: character - 1 },
          end: { line, character }
        },
        newText: ""
      }
    ]);
  });

  it("resolves member completions for chained member access", () => {
    const { source, line, character } = sourceWithCursor(
      "class Point(val x: int, val y: int)\n" +
      "class Holder(val point: Point)\n" +
      "fun demo() {\n" +
      "  const holder = new Holder(new Point(1, 2))\n" +
      "  holder.point.^^^x\n" +
      "}\n"
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
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
    const { source, line, character } = sourceWithCursor(
      "class Map<K, V> {\n" +
      "  a: K\n" +
      "  b: V\n" +
      "  get(key: K): V { }\n" +
      "}\n" +
      "fun demo() {\n" +
      "  const map = new Map<string, int>()\n" +
      "  map.^^^a\n" +
      "}\n"
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      { text: source }
    );
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("a")?.detail).toBe("Class property: string");
  });

  it("includes inherited generic members in completion details", () => {
    const { source, valueLine, valueCharacter } = (() => {
      const first = sourceWithCursor(
        "class Base<T> {\n" +
        "  value: T\n" +
        "  getValue(): T { }\n" +
        "}\n" +
        "class Child extends Base<string> {\n" +
        "}\n" +
        "fun demo() {\n" +
        "  const child = new Child()\n" +
        "  child.^^^v\n" +
        "  child.g\n" +
        "}\n"
      );
      return {
        source: first.source,
        valueLine: first.line,
        valueCharacter: first.character
      };
    })();
    const { line: methodLine, character: methodCharacter } = sourceWithCursor(
      "class Base<T> {\n" +
      "  value: T\n" +
      "  getValue(): T { }\n" +
      "}\n" +
      "class Child extends Base<string> {\n" +
      "}\n" +
      "fun demo() {\n" +
      "  const child = new Child()\n" +
      "  child.v\n" +
      "  child.^^^g\n" +
      "}\n"
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const valueItems = createCompletionItemsForPosition(
      session.ast!,
      valueLine,
      valueCharacter,
      session.analysis!,
      [],
      { text: source }
    );
    const valueByLabel = new Map(valueItems.map((item) => [item.label, item]));
    expect(valueByLabel.get("value")?.detail).toBe("Class property: string");

    const methodItems = createCompletionItemsForPosition(
      session.ast!,
      methodLine,
      methodCharacter,
      session.analysis!,
      [],
      { text: source }
    );
    const methodByLabel = new Map(methodItems.map((item) => [item.label, item]));

    expect(methodByLabel.get("getValue")?.detail).toBe("Class method: () => string");
  });

  it("ranks in-scope symbols by nearest scope distance", () => {
    const { source, line, character } = sourceWithCursor(
      "let top = 1\n" +
      "fun demo() {\n" +
      "  let outer = 2\n" +
      "  {\n" +
      "    let inner = 3\n" +
      "    ^^^inn\n" +
      "  }\n" +
      "}\n"
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
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
    const { source, line, character } = sourceWithCursor(
      "fun takesNumber(value: number) {\n" +
      "}\n" +
      "fun demo() {\n" +
      "  let exact: number = 2\n" +
      "  let count: int = 1\n" +
      "  let text: string = \"a\"\n" +
      "  takesNumber(^^^ex)\n" +
      "}\n"
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
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
