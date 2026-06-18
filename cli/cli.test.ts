import { afterEach, describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, readFile, readdir, rm, spawn, tmpdir, vi, writeFile } from "../compiler/test/expect";
import { createServer as createNetServer } from "node:net";
import { ensureLspTransportArg, runCli } from "./cli";
import { startServeSession } from "./cliServe";
import { COMPILER_VERSION } from "../compiler/compilerVersion";

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
  return await spawnAndCapture(
    process.execPath,
    [
      "node_modules/esbuild/bin/esbuild",
      "cli/cli-bin.ts",
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
}

async function readSseEvent(url: string, eventName: string): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: {
      Accept: "text/event-stream",
      Connection: "close"
    },
    signal: controller.signal
  });
  if (!response.body) {
    throw new Error("Missing SSE body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes("\n\n")) {
        const separator = buffer.indexOf("\n\n");
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const eventType = rawEvent.match(/^event:\s*(.+)$/m)?.[1]?.trim();
        const data = rawEvent.match(/^data:\s*(.+)$/m)?.[1]?.trim() ?? "";
        if (eventType === eventName) {
          controller.abort();
          return data;
        }
      }
    }
  } finally {
    reader.releaseLock();
    await response.body.cancel().catch(() => undefined);
  }
  throw new Error(`Event ${eventName} was not received`);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Connection: "close" }
  });
  return await response.text();
}

async function listenNetServer(port: number): Promise<import("node:net").Server> {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  return server;
}

async function closeNetServer(server: import("node:net").Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
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

  it("build command uses JSX factories from vexascript.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-"));
    const input = join(dir, "input-jsx.vx");
    const output = join(dir, "output-jsx.js");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({ compilerOptions: { jsxFactory: "h", jsxFragmentFactory: "Fragment" } }), "utf8");
    await writeFile(input, "const view = <><span>hi</span></>", "utf8");

    await runCli(["node", "vexa", "build", input, "--out", output]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).toContain('h(Fragment, null, h("span", null, "hi"))');
  });

  it("build command creates an ESM bundle inlining VexaScript, JavaScript, and node_modules dependencies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-bundle-"));
    const input = join(dir, "main.vx");
    const output = join(dir, "bundle.js");
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await writeFile(join(dir, "math.vx"), "export fun double(value: number) => value * 2\n", "utf8");
    await writeFile(join(dir, "message.ts"), "import { suffix } from './suffix.js'; export const label: string = `answer${suffix}`;\n", "utf8");
    await writeFile(join(dir, "suffix.js"), "export const suffix = '-from-js';\n", "utf8");
    await mkdir(join(dir, "node_modules", "tiny-lib"), { recursive: true });
    await writeFile(join(dir, "node_modules", "tiny-lib", "package.json"), JSON.stringify({ type: "module", main: "index.js" }), "utf8");
    await writeFile(join(dir, "node_modules", "tiny-lib", "index.js"), "export const offset = 1;\n", "utf8");
    await mkdir(join(dir, "node_modules", "tiny-cjs"), { recursive: true });
    await writeFile(join(dir, "node_modules", "tiny-cjs", "package.json"), JSON.stringify({ main: "index.cjs" }), "utf8");
    await writeFile(join(dir, "node_modules", "tiny-cjs", "index.cjs"), "exports.bump = (value) => value + 2;\n", "utf8");
    await writeFile(input, [
      'import { double } from "./math"',
      'import { label } from "./message.ts"',
      'import { offset } from "tiny-lib"',
      'import { bump } from "tiny-cjs"',
      'export const bundled = `${label}:${bump(double(20) + offset)}`'
    ].join("\n"), "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "build", input, "--bundle", "--out", output]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).not.toContain('from "./math"');
    expect(outputCode).not.toContain('from "./message.ts"');
    expect(outputCode).not.toContain('from "./suffix.js"');
    expect(outputCode).not.toContain('from "tiny-lib"');
    expect(outputCode).not.toContain('from "tiny-cjs"');
    expect(outputCode).not.toContain('node:module');
    expect(outputCode).not.toContain('createRequire');
    expect(outputCode).not.toContain(dir);
    expect(outputCode).toContain("function double(value)");
    expect(outputCode).toContain('const { suffix } = require("./suffix.js");');
    expect(outputCode).toContain('const label = "answer" + suffix + "";');
    expect(outputCode).toContain("exports.label = label;");
    expect(outputCode).toContain("const __vexaModules = {");
    expect(outputCode).toContain("async function (module, exports, __requireFrom)");
    expect(outputCode).toContain('const suffix = "-from-js";');
    expect(outputCode).toContain("exports.suffix = suffix;");

    const imported = await import(`${pathToFileURL(output).href}?${Date.now()}`) as { bundled: string };
    expect(imported.bundled).toBe("answer-from-js:43");
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Bundled:");
  });

  it("bundle command is a direct alias for build --bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-bundle-command-"));
    const input = join(dir, "main.vx");
    const output = join(dir, "direct-bundle.js");
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await writeFile(join(dir, "math.vx"), "export fun triple(value: number) => value * 3\n", "utf8");
    await writeFile(input, [
      'import { triple } from "./math"',
      'export const bundled = triple(14)'
    ].join("\n"), "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "bundle", input, "--out", output]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).toContain("function triple(value)");
    expect(outputCode).not.toContain('from "./math"');
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Bundled:");
  });

  it("serve command serves HTML, injects the bundle, and emits reload events after source changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-serve-"));
    const entry = join(dir, "main.vx");
    const html = join(dir, "index.html");
    await writeFile(entry, 'console.log("hello")\n', "utf8");
    await writeFile(html, "<!doctype html><html><body><script type=\"module\" src=\"%VEXA_ENTRYPOINT%\"></script></body></html>", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let session: Awaited<ReturnType<typeof startServeSession>> | null = null;
    try {
      session = await startServeSession({
        rootDir: dir,
        bundleInput: entry,
        port: 0
      });
      expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain(`Serving at http://localhost:${session.port} -- `);
      expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain(dir);
      expect(/^Bundled in \d+ms$/.test(String(logSpy.mock.calls[1]?.[0] ?? ""))).toBe(true);

      const baseUrl = `http://127.0.0.1:${session.port}`;
      const htmlText = await fetchText(baseUrl);
      expect(htmlText).toContain("/__vexa_bundle__.js");
      expect(htmlText).toContain("/__vexa_live_reload");

      const initialBundle = await fetchText(`${baseUrl}/__vexa_bundle__.js`);
      expect(initialBundle).toContain('console.log("hello");');

      const reloadPromise = readSseEvent(`${baseUrl}/__vexa_live_reload`, "reload");
      await writeFile(entry, 'console.log("updated")\n', "utf8");
      expect(await reloadPromise).toBeTruthy();
      expect(/^Bundled in \d+ms$/.test(String(logSpy.mock.calls.at(-1)?.[0] ?? ""))).toBe(true);

      const updatedBundle = await fetchText(`${baseUrl}/__vexa_bundle__.js`);
      expect(updatedBundle).toContain('console.log("updated");');
    } finally {
      logSpy.mockRestore();
      if (session) {
        await session.close();
      }
    }
  });

  it("serve command falls back to the next available port when the requested port is already in use", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-serve-port-fallback-"));
    const entry = join(dir, "main.vx");
    const html = join(dir, "index.html");
    await writeFile(entry, 'console.log("hello")\n', "utf8");
    await writeFile(html, "<!doctype html><html><body><script type=\"module\" src=\"%VEXA_ENTRYPOINT%\"></script></body></html>", "utf8");

    const blocker = await listenNetServer(0);
    const blockedPort = Number((blocker.address() as { port: number } | null)?.port ?? 0);
    let session: Awaited<ReturnType<typeof startServeSession>> | null = null;
    try {
      session = await startServeSession({
        rootDir: dir,
        bundleInput: entry,
        port: blockedPort
      });
      expect(session.port).toBeGreaterThan(blockedPort);

      const htmlText = await fetchText(`http://127.0.0.1:${session.port}`);
      expect(htmlText).toContain("/__vexa_bundle__.js");
    } finally {
      if (session) {
        await session.close();
      }
      await closeNetServer(blocker);
    }
  });

  it("serve command exposes mapped files and directories from vexascript.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-serve-mappings-"));
    const entry = join(dir, "main.vx");
    const html = join(dir, "index.html");
    await mkdir(join(dir, "node_modules", "pkg", "dist"), { recursive: true });
    await mkdir(join(dir, "public", "assets"), { recursive: true });
    await writeFile(entry, 'console.log("mapped")\n', "utf8");
    await writeFile(html, "<!doctype html><html><body><script src=\"mapped/pkg.js\"></script><img src=\"assets/logo.svg\" /><script type=\"module\" src=\"%VEXA_ENTRYPOINT%\"></script></body></html>", "utf8");
    await writeFile(join(dir, "node_modules", "pkg", "dist", "pkg.js"), "window.pkgLoaded = true;\n", "utf8");
    await writeFile(join(dir, "public", "assets", "logo.svg"), "<svg>mapped</svg>\n", "utf8");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({
      entrypoint: "main.vx",
      serveMappings: {
        "node_modules/pkg/dist/pkg.js": "mapped/pkg.js",
        "public/assets": "assets"
      }
    }), "utf8");

    let session: Awaited<ReturnType<typeof startServeSession>> | null = null;
    try {
      session = await startServeSession({
        rootDir: dir,
        bundleInput: entry,
        port: 0
      });

      const baseUrl = `http://127.0.0.1:${session.port}`;
      expect(await fetchText(`${baseUrl}/mapped/pkg.js`)).toContain("window.pkgLoaded = true;");
      expect(await fetchText(`${baseUrl}/assets/logo.svg`)).toContain("<svg>mapped</svg>");
      const htmlText = await fetchText(baseUrl);
      expect(htmlText).toContain('<script src="mapped/pkg.js"></script>');
      expect(htmlText).toContain('<img src="assets/logo.svg" />');
    } finally {
      if (session) {
        await session.close();
      }
    }
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
    await expect(runCli(["node", "vexa", "--version"])).rejects.toThrow("process.exit:0");

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

  it("built CLI emits a single executable bundle file", async () => {
    const distPath = join(process.cwd(), "dist");
    await rm(distPath, { recursive: true, force: true });

    const build = await buildBundledCli();
    expect(build.code).toBe(0);

    const distEntries = await readdir(distPath);
    expect(distEntries).toContain("vexa.js");
    expect(distEntries).not.toContain("cli.js");
  });

  it("built CLI prints help without arguments and exits successfully", async () => {
    const distPath = join(process.cwd(), "dist");
    await rm(distPath, { recursive: true, force: true });

    const build = await buildBundledCli();
    expect(build.code).toBe(0);

    const run = await spawnAndCapture(process.execPath, ["dist/vexa.js"], process.cwd());
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Usage: vexa [options] [command]");
    expect(run.stderr).toBe("");
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
