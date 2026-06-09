import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
    await writeFile(input, "for (a of 0 ..< 3) console.log(a)", "utf8");

    await runCli(["node", "mylang", "build", input, "--out", output, "--target", "conservative"]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).toContain(
      "for (const a of (function*(s, e) { for (let n = s; n < e; n++) yield n })(0, 3)) console.log(a);"
    );
  });

  it("build command uses JSX factories from tsconfig.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "input-jsx.my");
    const output = join(dir, "output-jsx.js");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { jsxFactory: "h", jsxFragmentFactory: "Fragment" } }), "utf8");
    await writeFile(input, "const view = <><span>hi</span></>", "utf8");

    await runCli(["node", "mylang", "build", input, "--out", output]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).toContain('h(Fragment, null, h("span", null, "hi"))');
  });

  it("build command creates an ESM bundle with MyLang, TypeScript, JavaScript, and package imports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-bundle-"));
    const input = join(dir, "main.my");
    const output = join(dir, "bundle.mjs");
    await writeFile(join(dir, "math.my"), "export fun double(value: number) => value * 2\n", "utf8");
    await writeFile(join(dir, "message.ts"), "import { suffix } from './suffix.js'; export const label: string = `answer${suffix}`;\n", "utf8");
    await writeFile(join(dir, "suffix.js"), "export const suffix = '-from-js';\n", "utf8");
    await mkdir(join(dir, "node_modules", "tiny-lib"), { recursive: true });
    await writeFile(join(dir, "node_modules", "tiny-lib", "package.json"), JSON.stringify({ type: "module", main: "index.js" }), "utf8");
    await writeFile(join(dir, "node_modules", "tiny-lib", "index.js"), "export const offset = 1;\n", "utf8");
    await writeFile(input, [
      'import { double } from "./math"',
      'import { label } from "./message.ts"',
      'import { offset } from "tiny-lib"',
      'export const bundled = `${label}:${double(20) + offset}`'
    ].join("\n"), "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "build", input, "--bundle", "--out", output]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).toContain("-from-js");
    expect(outputCode).toContain("offset = 1");
    expect(outputCode).not.toContain('from "./math"');
    expect(outputCode).not.toContain('from "./message.ts"');
    expect(outputCode).not.toContain('from "tiny-lib"');

    const imported = await import(`${pathToFileURL(output).href}?${Date.now()}`) as { bundled: string };
    expect(imported.bundled).toBe("answer-from-js:41");
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Bundled:");
  });

  it("bundle command is a direct alias for build --bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-bundle-command-"));
    const input = join(dir, "main.my");
    const output = join(dir, "direct-bundle.mjs");
    await writeFile(join(dir, "math.my"), "export fun triple(value: number) => value * 3\n", "utf8");
    await writeFile(input, [
      'import { triple } from "./math"',
      'export const bundled = triple(14)'
    ].join("\n"), "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "bundle", input, "--out", output]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).not.toContain('from "./math"');

    const imported = await import(`${pathToFileURL(output).href}?${Date.now()}`) as { bundled: number };
    expect(imported.bundled).toBe(42);
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Bundled:");
  });

  it("run command executes testFixtures/sample.my", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "run", "testFixtures/sample.my"]);

    expect(logSpy.mock.calls).toEqual([[42], [1], [2], [3], ['[a]'], ['[b]', { x: 4, y: 6 }]]);
  });

  it("run command supports conservative target mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "run-target.my");
    await writeFile(input, "for (a of 0 ..< 3) console.log(a)", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "run", input, "--target", "conservative"]);

    expect(logSpy.mock.calls).toEqual([[0], [1], [2]]);
  });

  it("run command uses JSX factories from tsconfig.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "run-jsx.my");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { jsxFactory: "h", jsxFragmentFactory: "Fragment" } }), "utf8");
    await writeFile(input, [
      'const Fragment = "fragment"',
      "fun h(type: any, props: any, child: any = null) {",
      "  return { type, props, child }",
      "}",
      "const view = <><span>hi</span></>",
      "console.log(view)"
    ].join("\n"), "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "run", input]);

    expect(logSpy.mock.calls[0]?.[0]).toEqual({
      type: "fragment",
      props: null,
      child: { type: "span", props: null, child: "hi" }
    });
  });

  it("build command reports compilation errors to stderr and fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "broken.my");
    await writeFile(input, "let = 1", "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["node", "mylang", "build", input])).rejects.toThrow("Compilation failed");
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0] ?? "")).toContain(" - ");
  });

  it("run command reports compilation errors to stderr and fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "broken-run.my");
    await writeFile(input, "let = 1", "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["node", "mylang", "run", input])).rejects.toThrow("Compilation failed");
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0] ?? "")).toContain("error");
  });

  it("run command includes semantic diagnostic codes in stderr output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "broken-nullable.my");
    await writeFile(input, [
      "interface MaybeRunner {",
      "  run(): MaybeRunner",
      "}",
      "let maybe: MaybeRunner | undefined",
      "let bad = maybe.run()"
    ].join("\n"), "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["node", "mylang", "run", input])).rejects.toThrow("Compilation failed");
    const rendered = errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");

    expect(rendered).toContain("MYL2019");
    expect(rendered).toContain("Object is possibly 'null' or 'undefined'");
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

  it("syntax command prints Monaco bundle source by default", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "syntax"]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("export const mylangMonacoSyntax =");
    expect(output).toContain("\"defaultToken\"");
  });

  it("syntax command prints VS Code grammar JSON", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "syntax", "--vscode-grammar"]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      scopeName?: string;
      repository?: Record<string, unknown>;
    };
    expect(output.scopeName).toBe("source.mylang");
    expect(output.repository).toBeDefined();
  });

  it("syntax command prints CodeMirror legacy mode source", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "syntax", "--codemirror"]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("export const mylangMode =");
    expect(output).toContain("blockCommentStart");
  });

  it("syntax command rejects multiple targets", async () => {
    await expect(runCli(["node", "mylang", "syntax", "--monaco", "--vscode"])).rejects.toThrow(
      "Syntax output expects exactly one target"
    );
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
    expect(ensureLspTransportArg(["node", "mylang", "lsp"])).toEqual([
      "node",
      "mylang",
      "lsp",
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
    expect(ensureLspTransportArg(["node", "mylang", "lsp", "--stdio"])).toEqual([
      "node",
      "mylang",
      "lsp",
      "--stdio"
    ]);
  });
});
