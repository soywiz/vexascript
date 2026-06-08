import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
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

    const worldSource = dedent`
      class Logger {
        log(value: number, text: string): int { return 0 }
      }
      
`;
    const helloSource = dedent`
      import { Logger } from "./world"
      fun demo() {
        const logger = new Logger()
        logger.log(1, "ok")
        logger.log("bad", 10)
        logger.log(1)
        logger.log(1, "ok", 2)
      }
      
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
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

  it("reports missing constructor arguments for imported classes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-types-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    await writeFile(worldFile, "class Point(val x: number, val y: number)\n", "utf8");
    await writeFile(
      helloFile, dedent`
      import { Point } from "./world"
      fun demo() {
        new Point()
        Point()
      }
      
`,
      "utf8"
    );

    const session = createAnalysisSession(dedent`
      import { Point } from "./world"
      fun demo() {
        new Point()
        Point()
      }
      `
    );
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(
      diagnostics.filter((diagnostic) => diagnostic.message === "Expected at least 2 argument(s), but got 0")
    ).toHaveLength(2);
  });

  it("anchors member-call arity diagnostics on the member name", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-types-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource = "class Logger {\n  log(value: number): int { return 0 }\n}\n";
    const helloSource = dedent`
      import { Logger } from "./world"
      fun demo() {
        const logger = new Logger()
        logger.log()
      }
      
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(
      diagnostics.find((diagnostic) => diagnostic.message === "Expected at least 1 argument(s), but got 0")
        ?.range.start
    ).toEqual({ line: 3, character: 9 });
  });

  it("does not duplicate same-file member-call arity diagnostics already reported by analysis", async () => {
    const source = dedent`
      class Logger {
        log(value: number): int { return 0 }
      }
      fun demo() {
        const logger = new Logger()
        logger.log()
      }
      
`;

    const session = createAnalysisSession(source);
    const diagnostics = await collectCrossFileTypeDiagnostics({
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
    const helloSource = dedent`
      import { Logger } from "./world"
      fun demo() {
        const logger = new Logger(1)
        logger.level(10)
      }
      
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages).toContain("Property 'level' of type 'Logger' is not callable");
  });

  it("supports variadic imported class methods", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-types-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource = "class Logger {\n  log(...values: number[]): int { return 0 }\n}\n";
    const helloSource = dedent`
      import { Logger } from "./world"
      fun demo() {
        const logger = new Logger()
        logger.log()
        logger.log(1, 2, 3)
        logger.log(1, "bad")
      }
      
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages).not.toContain("Expected at most 1 argument(s), but got 3");
    expect(messages).toContain(
      "Argument 2 of type 'string' is not assignable to parameter 'values' of type 'number[]'"
    );
  });

  it("reports cross-file incompatible assignment to class member", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-types-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource = "class Point(val y: int)\n";
    const helloSource = dedent`
      import { Point } from "./world"
      fun demo() {
        const point = new Point(1)
        point.y = "test"
      }
      
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
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

    const worldSource = dedent`
      class Map<K, V> {
        get(key: K): V { }
      }
      
`;
    const helloSource = dedent`
      import { Map } from "./world"
      fun demo() {
        const map = new Map<string, int>()
        const ok: int = map.get("id")
        const badArg: int = map.get(1)
        const badReturn: string = map.get("id")
      }
      
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
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

    const worldSource = dedent`
      class Base<T> {
        get(key: T): T { }
      }
      class Child extends Base<string> {
      }
      
`;
    const helloSource = dedent`
      import { Child } from "./world"
      fun demo() {
        const child = new Child()
        const ok: string = child.get("id")
        const badArg: string = child.get(1)
      }
      
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
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
    const helloSource = dedent`
      import { Logger } from "./world"
      fun demo() {
        const logger = new Logger()
        const invoke = () => logger.log("bad")
      }
    `.trimEnd() + "\n";

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "Argument 1 of type 'string' is not assignable to parameter 'value' of type 'number'"
    );
  });
});
