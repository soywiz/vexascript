import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAnalysisSession } from "./analysisSession";
import { createSignatureHelp } from "./signatureHelp";

describe("signature help", () => {
  it("provides function signature and active parameter index", () => {
    const source = dedent`
      fun sum(a: int, b: int): int {
        return a + b
      }
      fun demo() {
        return sum(1, 2)
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = createSignatureHelp(session.ast!, session.analysis!, 4, 15);
    expect(help).toEqual({
      signatures: [
        {
          label: "sum(a: int, b: int)",
          parameters: [{ label: "a: int" }, { label: "b: int" }]
        }
      ],
      activeSignature: 0,
      activeParameter: 1
    });
  });

  it("provides constructor signature for new expressions", () => {
    const source = dedent`
      class Point(val x: int, val y: int)
      fun demo() {
        return new Point(1, 2)
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = createSignatureHelp(session.ast!, session.analysis!, 2, 22);
    expect(help).toEqual({
      signatures: [
        {
          label: "new Point(x: int, y: int)",
          parameters: [{ label: "x: int" }, { label: "y: int" }]
        }
      ],
      activeSignature: 0,
      activeParameter: 1
    });
  });

  it("provides signature help for static members on ambient runtime constructors", () => {
    const source = dedent`
      fun script() {
        Date.parse("2024-01-01")
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = createSignatureHelp(session.ast!, session.analysis!, 1, 13);
    expect(help?.signatures[0]?.label).toEqual("parse(s: string)");
    expect(help?.signatures[0]?.parameters).toEqual([{ label: "s: string" }]);
    expect(help?.activeParameter).toEqual(0);
  });

  it("provides signature help for members on ambient runtime interface globals", () => {
    const source = dedent`
      fun script() {
        Math.max(1, 2)
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = createSignatureHelp(session.ast!, session.analysis!, 1, 11);
    expect(help?.signatures[0]?.label).toEqual("max(values: number[])");
  });

  it("resolves the innermost call inside a tail/brace lambda argument", () => {
    const source = dedent`
      fun inner(a: int, b: int): int {
        return a + b
      }
      fun outer(callback: (x: int) => void) {
      }
      fun demo() {
        outer({ value ->
          inner(1, 2)
        })
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = createSignatureHelp(session.ast!, session.analysis!, 7, 13);
    expect(help).toEqual({
      signatures: [
        {
          label: "inner(a: int, b: int)",
          parameters: [{ label: "a: int" }, { label: "b: int" }]
        }
      ],
      activeSignature: 0,
      activeParameter: 1
    });
  });

  it("returns null when cursor is outside invocation", () => {
    const source = "fun demo() {\n  let value = 1\n}\n";
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    expect(createSignatureHelp(session.ast!, session.analysis!, 1, 6)).toBeNull();
  });

  it("provides signature help and docs for imported class methods", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-signature-help-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource = dedent`
      class Logger {
        /**
         * Writes a number in the output stream.
         */
        log(value: number): int { return 0 }
      }
      `;
    const helloSource = dedent`
      import { Logger } from "./world"
      fun demo() {
        const logger = new Logger()
        logger.log(1)
      }
      `;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = createSignatureHelp(
      session.ast!,
      session.analysis!,
      3,
      12,
      {
        uri: pathToFileURL(helloFile).toString(),
        sourceRoots: [root]
      }
    );

    expect(help).toEqual({
      signatures: [
        {
          label: "log(value: number)",
          parameters: [{ label: "value: number" }],
          documentation: "Writes a number in the output stream."
        }
      ],
      activeSignature: 0,
      activeParameter: 0
    });
  });

  it("specializes generic method signature help from instantiated type", () => {
    const source = dedent`
      class Map<K, V> {
        get(key: K): V { }
      }
      fun demo() {
        const map = new Map<string, int>()
        map.get("id")
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = createSignatureHelp(session.ast!, session.analysis!, 5, 12);
    expect(help).toEqual({
      signatures: [
        {
          label: "get(key: string)",
          parameters: [{ label: "key: string" }]
        }
      ],
      activeSignature: 0,
      activeParameter: 0
    });
  });

  it("specializes signature help for inherited generic methods", () => {
    const source = dedent`
      class Base<T> {
        get(key: T): T { }
      }
      class Child extends Base<string> {
      }
      fun demo() {
        const child = new Child()
        child.get("id")
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = createSignatureHelp(session.ast!, session.analysis!, 7, 13);
    expect(help).toEqual({
      signatures: [
        {
          label: "get(key: string)",
          parameters: [{ label: "key: string" }]
        }
      ],
      activeSignature: 0,
      activeParameter: 0
    });
  });
});
