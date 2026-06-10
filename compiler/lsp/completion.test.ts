import { describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { createAnalysisSession } from "./analysisSession";
import { ensureDomProgram } from "compiler/runtime/domDeclarations";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems
} from "./completion";
import { collectImportedTypeDeclarations, collectImportedSymbolTypes } from "./importedDeclarations";
import { getProjectIndex } from "./projectAnalysis";

describe("createCompletionItemsForPosition", () => {
  it("includes in-scope variables and parameters inside function body", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      let top = 1
      fun demo(a, b: int) {
        let inner = a
        ^^^return inner
      }
      `
    );
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
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

  it("offers contextually typed Promise executor parameters", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      let promise = new Promise((resolve, reject) => {
        ^^^resolve(1)
      })
      `
    );
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("resolve")?.detail).toBe("In-scope parameter: (arg1: int) => void");
    expect(byLabel.get("reject")?.detail).toBe("In-scope parameter: (arg1: Error) => void");
  });

  it("does not suggest existing symbols while typing a function declaration name", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun demo(): number => 1
      fun demo2(): number => 2
      fun de^^^m()
    `);
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const labels = items.map((item) => item.label);

    expect(labels).not.toContain("demo");
    expect(labels).not.toContain("demo2");
  });

  it("does not suggest existing symbols while typing an incomplete function declaration name", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: number, val y: number)

      fun poin^^^
    `);
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).not.toContain("Point");
    expect(labels).not.toContain("PromiseConstructor");
  });

  it("does not suggest existing symbols while typing a parameter name", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      let shared = 1
      fun demo(par^^^am: int) {
        return shared
      }
    `);
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const labels = items.map((item) => item.label);

    expect(labels).not.toContain("shared");
    expect(labels).not.toContain("demo");
  });

  it("does not suggest existing symbols while typing a variable declaration name", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      let shared = 1
      let val^^^ue = shared
    `);
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const labels = items.map((item) => item.label);

    expect(labels).not.toContain("shared");
    expect(labels).not.toContain("value");
  });

  it("does not suggest existing symbols while typing a class member name", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Counter {
        total: int
        rea^^^d(): int {
          return total
        }
      }
    `);
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const labels = items.map((item) => item.label);

    expect(labels).not.toContain("total");
    expect(labels).not.toContain("read");
  });

  it("includes triple-slash documentation comments in in-scope function completions", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      /// searches [sub] in [str]
      /// and returns its index or -1
      fun demo(str: string, sub: string): int {
      }

      fun demo2() {
        de^^^mo()
      }
      `
    );
    const ast = parseFile(tokenizeReader(source));
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(ast, line, character, session.analysis!, [], { text: source });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("demo")?.documentation).toBe("searches [sub] in [str]\nand returns its index or -1");
  });

  it("suggests named arguments inside an empty call argument list", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun connect(host: string, port: number) {}
      connect(^^^)
      `
    );
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.has("host:")).toBe(true);
    expect(byLabel.has("port:")).toBe(true);
    expect(byLabel.get("host:")?.insertText).toBe("host: ");
    expect(byLabel.get("host:")?.filterText).toBe("host");
    expect(byLabel.get("host:")?.detail).toBe("Named argument: string");
  });

  it("suggests named arguments for new expressions", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: number, val y: number)
      val p = new Point(^^^)
      `
    );
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.has("x:")).toBe(true);
    expect(byLabel.has("y:")).toBe(true);
  });

  it("does not suggest named arguments outside of a call argument list", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun connect(host: string, port: number) {}
      ^^^connect
      `
    );
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const labels = items.map((item) => item.label);

    expect(labels).not.toContain("host:");
    expect(labels).not.toContain("port:");
  });

  it("keeps keyword completions available", async () => {
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

  it("includes auto-import completion items with additional text edits", async () => {
    const { source, line, character } = sourceWithCursor("fun demo() {\n  return ^^^Poi\n}\n");
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(
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

  it("computes auto-import completion items from exported-symbol callbacks", async () => {
    const { source, line, character } = sourceWithCursor("fun demo() {\n  return Poi^^^\n}\n");
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(
      ast,
      line,
      character,
      undefined,
      [],
      {
        text: source,
        uri: "file:///consumer.my",
        sourceRoots: [],
        getExportedSymbols: async () => [
          { name: "Point", filePath: "/models/point.my", kind: "class" },
        ],
      }
    );
    const point = items.find((item) => item.label === "Point");

    expect(point).toBeDefined();
    expect(point?.detail).toBe("Auto import from ./models/point");
    expect(point?.additionalTextEdits?.[0]?.newText).toBe(
      "import { Point } from \"./models/point\"\n"
    );
  });

  it("offers exported runtime namespace members for member access", async () => {
    const { source, line, character } = sourceWithCursor(
      "namespace Tools { export const version = 1; const hidden = 2; export function read() { return version } }\nTools.^^^"
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    expect(items.map((item) => item.label)).toEqual(expect.arrayContaining(["version", "read"]));
    expect(items.map((item) => item.label)).not.toContain("hidden");
  });

  it("offers ECMAScript runtime members for built-in globals", async () => {
    const { source, line, character } = sourceWithCursor("fun demo() {\n  Math.^^^\n}\n");
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["abs", "floor", "max", "random"]));
    expect(labels).not.toContain("demo");
  });

  it("offers DOM interface members for variables typed from tsconfig lib declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-completion-dom-"));
    const file = join(root, "main.my");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      fun createDocument(): Document => document
      const root: HTMLElement = createDocument().createElement("main")
      root.^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root]
    });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["className", "id", "children", "getAttribute", "setAttribute", "tagName"]));
  });

  it("offers local extension members for numeric literal member access", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class TimeSpan(val ms: number)
      val number.milliseconds => TimeSpan(this)
      val number.seconds => TimeSpan(this * 1000)
      10.^^^
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["milliseconds", "seconds"]));
  });

  it("offers generic Array extension members for array member access", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun <T> Array<T>.second(): T { return this[1] }
      val <T> Array<T>.doubledLength => length * 2
      let xs = [1, 2, 3]
      xs.^^^
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["second", "doubledLength"]));
  });

  it("offers auto-imported extension members for numeric literal member access", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-completion-"));
    const durationFile = join(root, "duration.my");
    const consumerFile = join(root, "consumer.my");
    await writeFile(
      durationFile, dedent`
      class TimeSpan(val ms: number)
      export val number.milliseconds => TimeSpan(this)
      export val number.seconds => TimeSpan(this * 1000)
      `,
      "utf8"
    );
    const { source, line, character } = sourceWithCursor("10.^^^\n");
    await writeFile(consumerFile, source, "utf8");

    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(consumerFile).toString(),
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => {
        if (filePath === durationFile) {
          return createAnalysisSession(dedent`
            class TimeSpan(val ms: number)
            export val number.milliseconds => TimeSpan(this)
            export val number.seconds => TimeSpan(this * 1000)
            `
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

  it("resolves chained members after extension properties", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class TimeSpan(val ms: number)
      val number.seconds => TimeSpan(this * 1000)
      10.seconds.^^^
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("ms");
  });

  it("offers constructor properties inside template interpolation", async () => {
    const source = dedent`
      class TimeSpan(val ms: number) {
        toString() => \`\${m}\`
      }
      `;
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, 1, 20, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels[0]).toBe("ms");
    expect(labels).toContain("this");
  });

  it("offers constructor properties inside empty template interpolation", async () => {
    const source = dedent`
      class TimeSpan(val ms: number) {
        toString() => \`\${}\`
      }
      `;
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, 1, 18, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels[0]).toBe("ms");
    expect(labels).toContain("this");
  });

  it("resolves member completions from explicitly typed variables", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun demo() {
        const result: Point = value
        return result.^^^
      }
      class Point(val x: int, val y: int)
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["x", "y"]));
    expect(labels).not.toEqual(expect.arrayContaining(["result", "value", "true"]));
  });

  it("prioritizes class member completions for member access", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: int, val y: int) {
        sum() {
          return 0
        }
      }
      fun demo() {
        const point = new Point(1, 2)
        point.^^^x
      }
      `
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();
    const items = await createCompletionItemsForPosition(
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

  it("offers Array<T> members for array-typed variable member access", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      declare class Array<T> {
        length: number
        push(item: T): number
        map<R>(callback: (value: T) => R): Array<R>
      }
      fun demo() {
        const items: int[] = []
        items.^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect([...byLabel.keys()]).toContain("push");
    expect([...byLabel.keys()]).toContain("map");
    expect([...byLabel.keys()]).toContain("length");
    expect(byLabel.get("push")?.detail).toBe("Class method: (item: int) => number");
  });

  it("offers Array<T> members for unknown[] member access", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      declare class Array<T> {
        push(item: T): number
      }
      fun demo() {
        const items: unknown[] = []
        items.^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("push");
  });
  it("offers Array<T> members after chained trailing-lambda calls", async () => {
    const { source, line, character } = sourceWithCursor(
      'val res = [1, 2, 3, 4, 5, 6].map { it * 2 }.filter { it % 3 == 0 }.map { "value" }.ma^^^'
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("map");
    expect(labels).not.toContain("Math");
  });

  it("offers members on an auto-awaited call receiver inside a sync function", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      declare class Response {
        arrayBuffer(): Promise<ArrayBuffer>
      }
      declare fun fetch(url: string): Promise<Response>
      sync fun demo() {
        fetch("https://hello.world/demo.txt").array^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("arrayBuffer");
    // The general identifier fallback (in-scope classes such as Array) must not
    // leak in when the receiver type is known.
    expect(labels).not.toContain("Array");
  });

  it("offers members after a bare dot on an auto-awaited call receiver inside a sync function", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      declare class Response {
        arrayBuffer(): Promise<ArrayBuffer>
      }
      declare fun fetch(url: string): Promise<Response>
      sync fun demo() {
        fetch("https://hello.world/demo.txt").^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("arrayBuffer");
  });

  it("offers members on a chained method-call receiver", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Builder {
        self(): Builder
        value(): int
      }
      fun demo(builder: Builder) {
        builder.self().val^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("value");
  });

  it("offers members after accessing a nullable inherited DOM member", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-completion-dom-child-"));
    const file = join(root, "main.my");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      const root: HTMLElement = document.createElement("main")
      root.firstChild.^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root]
    });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["nodeType", "parentNode", "textContent"]));
  });

  it("offers members after a DOM querySelector call receiver", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-completion-dom-query-selector-"));
    const file = join(root, "main.my");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      const root: HTMLElement = document.createElement("main")
      root.querySelector(".demo").^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root],
      recoverAnalysisSession: (recoveredSource) =>
        createAnalysisSession(recoveredSource, session.externalDeclarations, session.importedSymbolTypes, session.ambientDeclarations)
    });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["nodeType", "parentNode", "textContent", "querySelector"]));
  });

  it("offers members after an optional DOM querySelector call receiver", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-completion-dom-optional-query-selector-"));
    const file = join(root, "main.my");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      const root: HTMLElement = document.createElement("main")
      root.querySelector(".demo")?.^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root],
      recoverAnalysisSession: (recoveredSource) =>
        createAnalysisSession(recoveredSource, session.externalDeclarations, session.importedSymbolTypes, session.ambientDeclarations)
    });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["nodeType", "parentNode", "textContent", "querySelector"]));
  });

  it("offers members after a non-null-asserted DOM querySelector call receiver", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-completion-dom-non-null-query-selector-"));
    const file = join(root, "main.my");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      const root: HTMLElement = document.createElement("main")
      root.querySelector(".demo")!.^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root],
      recoverAnalysisSession: (recoveredSource) =>
        createAnalysisSession(recoveredSource, session.externalDeclarations, session.importedSymbolTypes, session.ambientDeclarations)
    });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["nodeType", "parentNode", "textContent", "querySelector"]));
  });

  it("offers members after accessing a member on a non-null-asserted DOM querySelector result", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-completion-dom-non-null-query-selector-child-"));
    const file = join(root, "main.my");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      const root: HTMLElement = document.createElement("main")
      root.querySelector(".demo")!.firstChild.^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root],
      recoverAnalysisSession: (recoveredSource) =>
        createAnalysisSession(recoveredSource, session.externalDeclarations, session.importedSymbolTypes, session.ambientDeclarations)
    });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["nodeType", "parentNode", "textContent"]));
  });

  it("includes constructor parameter properties in member completion", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class User { constructor(public id: string, readonly age: int) {} }
      let user = new User("a", 1)
      user.^^^id
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("id")?.detail).toBe("Class property: string");
    expect(byLabel.get("age")?.detail).toBe("Class property: int");
  });

  it("prioritizes primary constructor properties ahead of methods in member completion", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: number, val y: number) {
        operator+(other: Point): Point => Point(x + other.x, y + other.y)
        operator*(scale: number): Point => Point(x * scale, y * scale)
      }
      fun demo(point: Point) {
        point.^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels.slice(0, 2)).toEqual(["x", "y"]);
  });

  it("keeps operator member completions visible and edits member access safely", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: number, val y: number) {
        operator+(other: Point): Point => Point(x + other.x, y + other.y)
        operator*(scale: number): Point => Point(x * scale, y * scale)
      }
      fun demo(point: Point) {
        point.^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
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

  it("resolves member completions for chained member access", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: int, val y: int)
      class Holder(val point: Point)
      fun demo() {
        const holder = new Holder(new Point(1, 2))
        holder.point.^^^x
      }
      `
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = await createCompletionItemsForPosition(
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

  it("resolves specialized generic member types in completion details", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Map<K, V> {
        a: K
        b: V
        get(key: K): V { }
      }
      fun demo() {
        const map = new Map<string, int>()
        map.^^^a
      }
      `
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = await createCompletionItemsForPosition(
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

  it("includes inherited generic members in completion details", async () => {
    const { source, valueLine, valueCharacter } = (() => {
      const first = sourceWithCursor(dedent`
        class Base<T> {
          value: T
          getValue(): T { }
        }
        class Child extends Base<string> {
        }
        fun demo() {
          const child = new Child()
          child.^^^v
          child.g
        }
        `
      );
      return {
        source: first.source,
        valueLine: first.line,
        valueCharacter: first.character
      };
    })();
    const { line: methodLine, character: methodCharacter } = sourceWithCursor(dedent`
      class Base<T> {
        value: T
        getValue(): T { }
      }
      class Child extends Base<string> {
      }
      fun demo() {
        const child = new Child()
        child.v
        child.^^^g
      }
      `
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const valueItems = await createCompletionItemsForPosition(
      session.ast!,
      valueLine,
      valueCharacter,
      session.analysis!,
      [],
      { text: source }
    );
    const valueByLabel = new Map(valueItems.map((item) => [item.label, item]));
    expect(valueByLabel.get("value")?.detail).toBe("Class property: string");

    const methodItems = await createCompletionItemsForPosition(
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

  it("ranks in-scope symbols by nearest scope distance", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      let top = 1
      fun demo() {
        let outer = 2
        {
          let inner = 3
          ^^^inn
        }
      }
      `
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = await createCompletionItemsForPosition(
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

  it("ranks call-argument completions by expected parameter type relevance", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun takesNumber(value: number) {
      }
      fun demo() {
        let exact: number = 2
        let count: int = 1
        let text: string = "a"
        takesNumber(^^^ex)
      }
      `
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = await createCompletionItemsForPosition(
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

  it("offers members from a node_modules namespace when typing obj.^^^", async () => {
    const MINI_DTS = dedent`
      declare function pkg(x: string): pkg.Result;
      declare namespace pkg {
        interface Result {
          value(): string;
        }
        export function helper(): Result;
        export function parse(input: string): Result;
      }
      export = pkg;
    `;
    const root = await mkdtemp(join(tmpdir(), "mylang-completion-nm-"));
    const pkgDir = join(root, "node_modules", "pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "index.d.ts"), MINI_DTS, "utf8");
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", typings: "./index.d.ts" }),
      "utf8"
    );

    const mainPath = join(root, "main.my");
    const { source, line, character } = sourceWithCursor(dedent`
      import pkg from "pkg"
      pkg.^^^
    `);
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const ctx = { uri: pathToFileURL(mainPath).href, sourceRoots: [root], getSessionForFilePath: () => null };
    const declarations = await collectImportedTypeDeclarations(baseSession.ast!, ctx);
    const symbolTypes = await collectImportedSymbolTypes(baseSession.ast!, ctx);
    const session = createAnalysisSession(source, declarations, symbolTypes);

    const items = await createCompletionItemsForPosition(
      session.ast!, line, character, session.analysis!, [],
      { text: source, uri: ctx.uri }
    );
    const labels = items.map((item) => item.label);
    expect(labels).toContain("helper");
    expect(labels).toContain("parse");
  });

  it("offers members from imported object type aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-completion-type-alias-"));
    const scenariosPath = join(root, "scenarios.my");
    const mainPath = join(root, "main.my");
    await writeFile(scenariosPath, dedent`
      export type Scenario = {
        label: string,
        source: string,
        showTree?: boolean
      }
    `, "utf8");
    const first = sourceWithCursor(dedent`
      import { Scenario } from "./scenarios.my"

      function lex(source: string) {}

      function summarizeScenario(scenario: Scenario): string {
        const tokens = lex(scenario.sou^^^)
      }
    `);
    await writeFile(mainPath, first.source, "utf8");

    const session = createAnalysisSession(first.source);
    const items = await createCompletionItemsForPosition(
      session.ast!,
      first.line,
      first.character,
      session.analysis!,
      [],
      {
        text: first.source,
        uri: pathToFileURL(mainPath).href,
        sourceRoots: [root]
      }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("source");

    const labelPrefix = sourceWithCursor(dedent`
      import { Scenario } from "./scenarios.my"

      function summarizeScenario(scenario: Scenario): string {
        return scenario.lab^^^
      }
    `);
    await writeFile(mainPath, labelPrefix.source, "utf8");
    const labelSession = createAnalysisSession(labelPrefix.source);
    const labelItems = await createCompletionItemsForPosition(
      labelSession.ast!,
      labelPrefix.line,
      labelPrefix.character,
      labelSession.analysis!,
      [],
      {
        text: labelPrefix.source,
        uri: pathToFileURL(mainPath).href,
        sourceRoots: [root]
      }
    );
    const labelLabels = labelItems.map((item) => item.label);

    expect(labelLabels).toContain("label");

    const second = sourceWithCursor(dedent`
      import { Scenario } from "./scenarios.my"

      function summarizeScenario(scenario: Scenario): string {
        return scenario.^^^
      }
    `);
    await writeFile(mainPath, second.source, "utf8");
    const secondSession = createAnalysisSession(second.source);
    const secondItems = await createCompletionItemsForPosition(
      secondSession.ast!,
      second.line,
      second.character,
      secondSession.analysis!,
      [],
      {
        text: second.source,
        uri: pathToFileURL(mainPath).href,
        sourceRoots: [root]
      }
    );
    const secondLabels = secondItems.map((item) => item.label);

    expect(secondLabels).toContain("label");
    expect(secondLabels).toContain("source");
    expect(secondLabels).toContain("showTree");
  });

  it("offers members when imported aliases are expanded to structural object types", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-completion-structural-type-"));
    const scenariosPath = join(root, "scenarios.my");
    const mainPath = join(root, "main.my");
    await writeFile(scenariosPath, dedent`
      export type Scenario = {
        label: string,
        source: string,
        showTree?: boolean
      }
    `, "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      import { Scenario } from "./scenarios.my"

      function lex(source: string) {}

      function summarizeScenario(scenario: Scenario): string {
        const tokens = lex(scenario.lab^^^)
      }
    `);
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const projectIndex = getProjectIndex([root]);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).href,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath)
    });
    const importedSymbolTypes = await collectImportedSymbolTypes(baseSession.ast!, {
      uri: pathToFileURL(mainPath).href,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath)
    });
    const session = createAnalysisSession(source, externalDeclarations, importedSymbolTypes);
    const items = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      {
        text: source,
        uri: pathToFileURL(mainPath).href,
        sourceRoots: [root],
        getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath),
        recoverAnalysisSession: (recovered) => createAnalysisSession(recovered, externalDeclarations, importedSymbolTypes)
      }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("label");
    expect(labels).not.toContain("Lowercase");
  });
});
