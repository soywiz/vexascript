import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import { expect, vi } from "./test/expect";
import { ensureLspTransportArg, runCli } from "./cli";
import { COMPILER_VERSION } from "./compilerVersion";

async function spawnAndCapture(command: string, args: string[], cwd: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function buildBundledCli(): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const bootstrapBuild = await spawnAndCapture(
    process.execPath,
    [
      "node_modules/esbuild/bin/esbuild",
      "compiler/cli-bin.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node20",
      "--outfile=dist/vexa.js",
      "--external:commander",
      "--external:vscode-languageserver",
      "--external:vscode-languageserver-textdocument",
      "--external:source-map",
      "--external:esbuild",
      "--banner:js=#!/usr/bin/env node",
      "--log-level=error",
    ],
    process.cwd()
  );
  if (bootstrapBuild.code !== 0) {
    return bootstrapBuild;
  }
  return await spawnAndCapture(
    process.execPath,
    [
      "node_modules/esbuild/bin/esbuild",
      "compiler/cli.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node20",
      "--outfile=dist/cli.js",
      "--external:commander",
      "--external:vscode-languageserver",
      "--external:vscode-languageserver-textdocument",
      "--external:source-map",
      "--external:esbuild",
      "--log-level=error",
    ],
    process.cwd()
  );
}

describe("CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("build command writes transpiled output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-"));
    const input = join(dir, "input.vx");
    const output = join(dir, "output.js");
    await writeFile(input, "let value = 1 + 2", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "build", input, "--out", output]);

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
    expect(sourceMap.sources).toEqual(["input.vx"]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Compiled:");
  });

  it("build command supports conservative target mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-"));
    const input = join(dir, "input-target.vx");
    const output = join(dir, "output-target.js");
    await writeFile(input, "for (a of 0 ..< 3) console.log(a)", "utf8");

    await runCli(["node", "vexa", "build", input, "--out", output, "--target", "conservative"]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).toContain(
      "for (const a of (function*(s, e) { for (let n = s; n < e; n++) yield n })(0, 3)) console.log(a);"
    );
  });

  it("build command uses JSX factories from tsconfig.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-"));
    const input = join(dir, "input-jsx.vx");
    const output = join(dir, "output-jsx.js");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { jsxFactory: "h", jsxFragmentFactory: "Fragment" } }), "utf8");
    await writeFile(input, "const view = <><span>hi</span></>", "utf8");

    await runCli(["node", "vexa", "build", input, "--out", output]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).toContain('h(Fragment, null, h("span", null, "hi"))');
  });

  it("build command creates an ESM bundle inlining VexaScript and TypeScript, leaving JS and npm imports as ESM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-bundle-"));
    const input = join(dir, "main.vx");
    const output = join(dir, "bundle.mjs");
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await writeFile(join(dir, "math.vx"), "export fun double(value: number) => value * 2\n", "utf8");
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

    await runCli(["node", "vexa", "build", input, "--bundle", "--out", output]);

    const outputCode = await readFile(output, "utf8");
    // VexaScript and TypeScript imports are inlined — their specifiers disappear
    expect(outputCode).not.toContain('from "./math"');
    expect(outputCode).not.toContain('from "./message.ts"');
    // Plain JS and npm package imports remain as ESM (Node.js resolves them at runtime)
    expect(outputCode).toContain('from "./suffix.js"');
    expect(outputCode).toContain('from "tiny-lib"');

    // The bundle is fully runnable: Node.js resolves the remaining ESM imports
    const imported = await import(`${pathToFileURL(output).href}?${Date.now()}`) as { bundled: string };
    expect(imported.bundled).toBe("answer-from-js:41");
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Bundled:");
  });

  it("bundle command is a direct alias for build --bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-bundle-command-"));
    const input = join(dir, "main.vx");
    const output = join(dir, "direct-bundle.mjs");
    await writeFile(join(dir, "math.vx"), "export fun triple(value: number) => value * 3\n", "utf8");
    await writeFile(input, [
      'import { triple } from "./math"',
      'export const bundled = triple(14)'
    ].join("\n"), "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "bundle", input, "--out", output]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).not.toContain('from "./math"');

    const imported = await import(`${pathToFileURL(output).href}?${Date.now()}`) as { bundled: number };
    expect(imported.bundled).toBe(42);
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Bundled:");
  });

  it("run command executes testFixtures/sample.vx", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "run", "testFixtures/sample.vx"]);

    expect(logSpy.mock.calls).toEqual([[42], [1], [2], [3], ['[a]'], ['[b]', { x: 4, y: 6 }]]);
  });

  it("run command supports conservative target mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-"));
    const input = join(dir, "run-target.vx");
    await writeFile(input, "for (a of 0 ..< 3) console.log(a)", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "run", input, "--target", "conservative"]);

    expect(logSpy.mock.calls).toEqual([[0], [1], [2]]);
  });

  it("run command uses JSX factories from tsconfig.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-"));
    const input = join(dir, "run-jsx.vx");
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

    await runCli(["node", "vexa", "run", input]);

    expect(logSpy.mock.calls[0]?.[0]).toEqual({
      type: "fragment",
      props: null,
      child: { type: "span", props: null, child: "hi" }
    });
  });

  it("build command reports compilation errors to stderr and fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-"));
    const input = join(dir, "broken.vx");
    await writeFile(input, "let = 1", "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["node", "vexa", "build", input])).rejects.toThrow("Compilation failed");
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0] ?? "")).toContain(" - ");
  });

  it("run command reports compilation errors to stderr and fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-"));
    const input = join(dir, "broken-run.vx");
    await writeFile(input, "let = 1", "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["node", "vexa", "run", input])).rejects.toThrow("Compilation failed");
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0] ?? "")).toContain("error");
  });

  it("run command includes semantic diagnostic codes in stderr output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-"));
    const input = join(dir, "broken-nullable.vx");
    await writeFile(input, [
      "interface MaybeRunner {",
      "  run(): MaybeRunner",
      "}",
      "let maybe: MaybeRunner | undefined",
      "let bad = maybe.run()"
    ].join("\n"), "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["node", "vexa", "run", input])).rejects.toThrow("Compilation failed");
    const rendered = errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");

    expect(rendered).toContain("MYL2019");
    expect(rendered).toContain("Object is possibly 'null' or 'undefined'");
  });

  it("tokens command prints token list as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-"));
    const input = join(dir, "tokens.vx");
    await writeFile(input, "a += 1", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "tokens", input]);

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
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-"));
    const input = join(dir, "ast.vx");
    await writeFile(input, "let myvar = 1 + 2;", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "ast", input]);

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

    await runCli(["node", "vexa", "syntax"]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("export const vexaMonacoSyntax =");
    expect(output).toContain("\"defaultToken\"");
  });

  it("reports the compiler version from the root package.json", async () => {
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((...args: unknown[]) => {
      throw new Error(`process.exit:${typeof args[0] === "number" ? args[0] : 0}`);
    });
    await expect(runCli(["node", "vexa", "--version"])).rejects.toThrow(`process.exit:0`);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stdoutWriteSpy.mock.calls.some((call) => String(call[0] ?? "").includes(COMPILER_VERSION))).toBe(true);
  });

  it("built CLI starts without unsettled top-level await warnings", async () => {
    const distPath = join(process.cwd(), "dist");
    await rm(distPath, { recursive: true, force: true });

    const build = await buildBundledCli();
    expect(build.code).toBe(0);
    expect(build.stderr).toBe("");

    const run = await spawnAndCapture(process.execPath, ["dist/vexa.js", "--version"], process.cwd());
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(COMPILER_VERSION);
    expect(run.stderr).not.toContain("Detected unsettled top-level await");
  });

  it("built CLI runs sample programs and preserves stdout", async () => {
    const distPath = join(process.cwd(), "dist");
    await rm(distPath, { recursive: true, force: true });

    const build = await buildBundledCli();
    expect(build.code).toBe(0);

    const run = await spawnAndCapture(process.execPath, ["dist/vexa.js", "run", "samples/node/main.vx"], process.cwd());
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("hello/world");
    expect(run.stdout).toContain("0010");
    expect(run.stdout).toContain("74657374");
    expect(run.stderr).toBe("");
  });

  it("syntax command prints VS Code grammar JSON", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "syntax", "--vscode-grammar"]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      scopeName?: string;
      repository?: Record<string, unknown>;
    };
    expect(output.scopeName).toBe("source.vexa");
    expect(output.repository).toBeDefined();
  });

  it("syntax command prints CodeMirror legacy mode source", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "syntax", "--codemirror"]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("export const vexaMode =");
    expect(output).toContain("blockCommentStart");
  });

  it("syntax command rejects multiple targets", async () => {
    await expect(runCli(["node", "vexa", "syntax", "--monaco", "--vscode"])).rejects.toThrow(
      "Syntax output expects exactly one target"
    );
  });

  it("format command overwrites input file with formatted source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-"));
    const input = join(dir, "format.vx");
    await writeFile(input, "let a=1\na+=2", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "format", input]);

    expect(await readFile(input, "utf8")).toBe("let a = 1\na += 2\n");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Formatted:");
  });

  it("format command writes formatted source with --write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-"));
    const input = join(dir, "format-write.vx");
    await writeFile(input, "let a=1\na+=2", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "format", input, "--write"]);

    expect(await readFile(input, "utf8")).toBe("let a = 1\na += 2\n");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Formatted:");
  });

  it("test command discovers and executes .test.vx files with test and assert helpers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-tests-"));
    const testFile = join(dir, "math.test.vx");
    await writeFile(testFile, "test(() => { assert(1 + 1 == 2) })", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "test", dir]);

    expect(logSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      `Passed: ${testFile}`,
      "1 test file passed"
    ]);
  });

  it("test command fails when an inline assertion fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-tests-"));
    const testFile = join(dir, "failure.test.vx");
    await writeFile(testFile, 'test(() => { assert(false, "expected true") })', "utf8");

    await expect(runCli(["node", "vexa", "test", testFile])).rejects.toThrow("expected true");
  });

  it("adds --stdio when starting language server without transport arg", () => {
    expect(ensureLspTransportArg(["node", "vexa", "--lsp"])).toEqual([
      "node",
      "vexa",
      "--lsp",
      "--stdio"
    ]);
    expect(ensureLspTransportArg(["node", "vexa", "lsp"])).toEqual([
      "node",
      "vexa",
      "lsp",
      "--stdio"
    ]);
  });

  it("keeps existing language server transport arg", () => {
    expect(ensureLspTransportArg(["node", "vexa", "--lsp", "--stdio"])).toEqual([
      "node",
      "vexa",
      "--lsp",
      "--stdio"
    ]);
    expect(ensureLspTransportArg(["node", "vexa", "--lsp", "--node-ipc"])).toEqual([
      "node",
      "vexa",
      "--lsp",
      "--node-ipc"
    ]);
    expect(ensureLspTransportArg(["node", "vexa", "--lsp", "--socket=6010"])).toEqual([
      "node",
      "vexa",
      "--lsp",
      "--socket=6010"
    ]);
    expect(ensureLspTransportArg(["node", "vexa", "lsp", "--stdio"])).toEqual([
      "node",
      "vexa",
      "lsp",
      "--stdio"
    ]);
  });
});
