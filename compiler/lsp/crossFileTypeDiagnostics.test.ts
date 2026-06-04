import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAnalysisSession } from "./analysisSession";
import { collectCrossFileTypeDiagnostics } from "./crossFileTypeDiagnostics";

describe("cross-file type diagnostics", () => {
  it("reports argument count and type errors for imported class methods", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-types-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource =
      "class Logger {\n" +
      "  log(value: number, text: string): int { return 0 }\n" +
      "}\n";
    const helloSource =
      "import { Logger } from \"./world\"\n" +
      "fun demo() {\n" +
      "  const logger = new Logger()\n" +
      "  logger.log(1, \"ok\")\n" +
      "  logger.log(\"bad\", 10)\n" +
      "  logger.log(1)\n" +
      "  logger.log(1, \"ok\", 2)\n" +
      "}\n";

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages).toContain(
      "Argument 1 of type 'string' is not assignable to parameter 'value' of type 'number'"
    );
    expect(messages).toContain(
      "Argument 2 of type 'int' is not assignable to parameter 'text' of type 'string'"
    );
    expect(messages).toContain("Expected at least 2 argument(s), but got 1");
    expect(messages).toContain("Expected at most 2 argument(s), but got 3");
    expect(messages).toContain(
      "Unexpected argument 3; function expects at most 2 argument(s)"
    );
  });

  it("anchors member-call arity diagnostics on the member name", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-types-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource = "class Logger {\n  log(value: number): int { return 0 }\n}\n";
    const helloSource =
      "import { Logger } from \"./world\"\n" +
      "fun demo() {\n" +
      "  const logger = new Logger()\n" +
      "  logger.log()\n" +
      "}\n";

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(
      diagnostics.find((diagnostic) => diagnostic.message === "Expected at least 1 argument(s), but got 0")
        ?.range.start
    ).toEqual({ line: 3, character: 9 });
  });

  it("does not duplicate same-file member-call arity diagnostics already reported by analysis", () => {
    const source =
      "class Logger {\n" +
      "  log(value: number): int { return 0 }\n" +
      "}\n" +
      "fun demo() {\n" +
      "  const logger = new Logger()\n" +
      "  logger.log()\n" +
      "}\n";

    const session = createAnalysisSession(source);
    const diagnostics = collectCrossFileTypeDiagnostics({
      uri: "file:///demo.my",
      session,
      sourceRoots: []
    });

    expect(
      diagnostics.some((diagnostic) => diagnostic.message === "Expected at least 1 argument(s), but got 0")
    ).toBe(false);
  });

  it("reports non-callable member usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-types-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource = "class Logger(val level: number)\n";
    const helloSource =
      "import { Logger } from \"./world\"\n" +
      "fun demo() {\n" +
      "  const logger = new Logger(1)\n" +
      "  logger.level(10)\n" +
      "}\n";

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages).toContain("Property 'level' of type 'Logger' is not callable");
  });

  it("reports cross-file incompatible assignment to class member", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-types-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource = "class Point(val y: int)\n";
    const helloSource =
      "import { Point } from \"./world\"\n" +
      "fun demo() {\n" +
      "  const point = new Point(1)\n" +
      "  point.y = \"test\"\n" +
      "}\n";

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("specializes generic method arguments and return diagnostics across files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-types-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource =
      "class Map<K, V> {\n" +
      "  get(key: K): V { }\n" +
      "}\n";
    const helloSource =
      "import { Map } from \"./world\"\n" +
      "fun demo() {\n" +
      "  const map = new Map<string, int>()\n" +
      "  const ok: int = map.get(\"id\")\n" +
      "  const badArg: int = map.get(1)\n" +
      "  const badReturn: string = map.get(\"id\")\n" +
      "}\n";

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages).toContain(
      "Argument 1 of type 'int' is not assignable to parameter 'key' of type 'string'"
    );
  });

  it("specializes inherited generic method arguments across files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-types-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource =
      "class Base<T> {\n" +
      "  get(key: T): T { }\n" +
      "}\n" +
      "class Child extends Base<string> {\n" +
      "}\n";
    const helloSource =
      "import { Child } from \"./world\"\n" +
      "fun demo() {\n" +
      "  const child = new Child()\n" +
      "  const ok: string = child.get(\"id\")\n" +
      "  const badArg: string = child.get(1)\n" +
      "}\n";

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages).toContain(
      "Argument 1 of type 'int' is not assignable to parameter 'key' of type 'string'"
    );
  });

  it("reports cross-file call errors nested in arrow-function expressions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-types-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource = "class Logger { log(value: number): int { return 0 } }\n";
    const helloSource =
      'import { Logger } from "./world"\n' +
      "fun demo() {\n" +
      "  const logger = new Logger()\n" +
      '  const invoke = () => logger.log("bad")\n' +
      "}\n";

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "Argument 1 of type 'string' is not assignable to parameter 'value' of type 'number'"
    );
  });
});
