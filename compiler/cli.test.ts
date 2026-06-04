import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { expect, vi } from "./test/expect";
import { ensureLspTransportArg, runCli } from "./cli";

describe("CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("build command writes transpiled output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "input.my");
    const output = join(dir, "output.js");
    await writeFile(input, "let value = 1 + 2", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "build", input, "--out", output]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).toContain("let value = 1 + 2;");
    expect(outputCode).toContain("//# sourceMappingURL=output.js.map");
    const sourceMap = JSON.parse(await readFile(`${output}.map`, "utf8")) as {
      version: number;
      file: string;
      sources: string[];
    };
    expect(sourceMap.version).toBe(3);
    expect(sourceMap.file).toBe("output.js");
    expect(sourceMap.sources).toEqual(["input.my"]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Compiled:");
  });

  it("build command supports conservative target mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "input-target.my");
    const output = join(dir, "output-target.js");
    await writeFile(input, "for (a of 0 ... 3) console.log(a)", "utf8");

    await runCli(["node", "mylang", "build", input, "--out", output, "--target", "conservative"]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).toContain(
      "for (const a of (function*(s, e) { for (let n = s; n < e; n++) yield n })(0, 3)) console.log(a);"
    );
  });

  it("run command executes testFixtures/sample.my", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "run", "testFixtures/sample.my"]);

    expect(logSpy.mock.calls).toEqual([[42], [1], [2], [3]]);
  });

  it("run command supports conservative target mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "run-target.my");
    await writeFile(input, "for (a of 0 ... 3) console.log(a)", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "run", input, "--target", "conservative"]);

    expect(logSpy.mock.calls).toEqual([[0], [1], [2]]);
  });

  it("build command reports compilation errors to stderr and fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "broken.my");
    await writeFile(input, "let = 1", "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["node", "mylang", "build", input])).rejects.toThrow("Compilation failed");
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0] ?? "")).toContain("error:");
  });

  it("run command reports compilation errors to stderr and fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "broken-run.my");
    await writeFile(input, "let = 1", "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["node", "mylang", "run", input])).rejects.toThrow("Compilation failed");
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0] ?? "")).toContain("error:");
  });

  it("tokens command prints token list as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "tokens.my");
    await writeFile(input, "a += 1", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "tokens", input]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const tokens = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "[]")) as Array<{ type: string; value: string }>;
    expect(tokens.map(({ type, value }) => ({ type, value }))).toEqual([
      { type: "identifier", value: "a" },
      { type: "symbol", value: "+=" },
      { type: "number", value: "1" },
      { type: "eof", value: "<eof>" }
    ]);
  });

  it("ast command prints parsed AST as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "ast.my");
    await writeFile(input, "let myvar = 1 + 2;", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "ast", input]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"))).toEqual({
      kind: "Program",
      body: [
        {
          kind: "VarStatement",
          declarationKind: "let",
          name: { kind: "Identifier", name: "myvar" },
          initializer: {
            kind: "BinaryExpression",
            operator: "+",
            left: { kind: "IntLiteral", value: 1 },
            right: { kind: "IntLiteral", value: 2 }
          }
        }
      ]
    });
  });

  it("format command overwrites input file with formatted source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "format.my");
    await writeFile(input, "let a=1\na+=2", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "format", input]);

    expect(await readFile(input, "utf8")).toBe("let a = 1\na += 2\n");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Formatted:");
  });

  it("format command writes formatted source with --write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "format-write.my");
    await writeFile(input, "let a=1\na+=2", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "format", input, "--write"]);

    expect(await readFile(input, "utf8")).toBe("let a = 1\na += 2\n");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Formatted:");
  });

  it("test command discovers and executes .test.my files with test and assert helpers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-tests-"));
    const testFile = join(dir, "math.test.my");
    await writeFile(testFile, "test(() => { assert(1 + 1 == 2) })", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "test", dir]);

    expect(logSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      `Passed: ${testFile}`,
      "1 test file passed"
    ]);
  });

  it("test command fails when an inline assertion fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-tests-"));
    const testFile = join(dir, "failure.test.my");
    await writeFile(testFile, 'test(() => { assert(false, "expected true") })', "utf8");

    await expect(runCli(["node", "mylang", "test", testFile])).rejects.toThrow("expected true");
  });

  it("adds --stdio when starting language server without transport arg", () => {
    expect(ensureLspTransportArg(["node", "mylang", "--lsp"])).toEqual([
      "node",
      "mylang",
      "--lsp",
      "--stdio"
    ]);
  });

  it("keeps existing language server transport arg", () => {
    expect(ensureLspTransportArg(["node", "mylang", "--lsp", "--stdio"])).toEqual([
      "node",
      "mylang",
      "--lsp",
      "--stdio"
    ]);
    expect(ensureLspTransportArg(["node", "mylang", "--lsp", "--node-ipc"])).toEqual([
      "node",
      "mylang",
      "--lsp",
      "--node-ipc"
    ]);
    expect(ensureLspTransportArg(["node", "mylang", "--lsp", "--socket=6010"])).toEqual([
      "node",
      "mylang",
      "--lsp",
      "--socket=6010"
    ]);
  });
});
