import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAnalysisSession } from "./analysisSession";
import { createSignatureHelp } from "./signatureHelp";

describe("signature help", () => {
  it("provides function signature and active parameter index", () => {
    const source =
      "fun sum(a: int, b: int): int {\n" +
      "  return a + b\n" +
      "}\n" +
      "fun demo() {\n" +
      "  return sum(1, 2)\n" +
      "}\n";

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
    const source =
      "class Point(val x: int, val y: int)\n" +
      "fun demo() {\n" +
      "  return new Point(1, 2)\n" +
      "}\n";

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

    const worldSource =
      "class Logger {\n" +
      "  /**\n" +
      "   * Writes a number in the output stream.\n" +
      "   */\n" +
      "  log(value: number): int { return 0 }\n" +
      "}\n";
    const helloSource =
      "import { Logger } from \"./world\"\n" +
      "fun demo() {\n" +
      "  const logger = new Logger()\n" +
      "  logger.log(1)\n" +
      "}\n";

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
    const source =
      "class Map<K, V> {\n" +
      "  get(key: K): V { }\n" +
      "}\n" +
      "fun demo() {\n" +
      "  const map = new Map<string, int>()\n" +
      "  map.get(\"id\")\n" +
      "}\n";

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
});
