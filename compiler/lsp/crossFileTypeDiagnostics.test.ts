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
});
