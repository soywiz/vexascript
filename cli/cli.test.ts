import { afterEach, describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, readFile, readdir, resolve, rm, spawn, tmpdir, vi, writeFile } from "../compiler/test/expect";
import { createServer as createNetServer } from "node:net";
import { chmod } from "node:fs/promises";
import { build as buildWithEsbuild } from "esbuild";
import { ensureLspTransportArg, runCli } from "./cli";
import { startServeSession } from "./cliServe";
import { COMPILER_VERSION } from "../compiler/compilerVersion";
import { runCommandCapture } from "./io";
import { textModulePlugin } from "../scripts/textModulePlugin";

async function buildBundledCli(): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return await runCommandCapture(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/build.ts"
    ],
    { cwd: process.cwd() }
  );
}

async function readSseEvent(url: string, eventName: string, options: { waitForReady?: boolean; onReady?: () => void } = {}): Promise<string> {
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
  let readyReceived = !options.waitForReady;
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
        if (eventType === "ready") {
          readyReceived = true;
          options.onReady?.();
        }
        if (!readyReceived) {
          continue;
        }
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
    const compilationLog = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(compilationLog).toContain("Compiled:");
    expect(
      /\(source-load [\d.]+ms, project-load [\d.]+ms, declarations [\d.]+ms, type-check [\d.]+ms, parse [\d.]+ms, analysis [\d.]+ms, emit [\d.]+ms, write [\d.]+ms, total [\d.]+ms\)$/.test(compilationLog)
    ).toBe(true);
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

  it("build and bundle use the configured entrypoint when input is omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-entrypoint-"));
    const input = join(dir, "src", "main.vx");
    const buildOutput = join(dir, "build.js");
    const bundleOutput = join(dir, "bundle.js");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({ entrypoint: "src/main.vx" }), "utf8");
    await writeFile(input, "export const answer = 42\n", "utf8");

    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      await runCli(["node", "vexa", "build", "--out", buildOutput]);
      await runCli(["node", "vexa", "bundle", "--out", bundleOutput]);
    } finally {
      process.chdir(previousCwd);
    }

    expect(await readFile(buildOutput, "utf8")).toContain("export const answer = 42;");
    const bundled = await readFile(bundleOutput, "utf8");
    expect(bundled).toContain("const answer = 42;");
    expect(bundled).toContain("export { __vexa_export_answer as answer }");
  });

  it("run command supports Deno with all permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-run-deno-"));
    const input = join(dir, "input.vx");
    const fakeDeno = join(dir, "deno");
    const argsFile = join(dir, "deno-args.json");
    await writeFile(input, 'console.log("deno")\n', "utf8");
    await writeFile(fakeDeno, [
      `#!${process.execPath}`,
      'import { writeFile } from "node:fs/promises";',
      'await writeFile(process.env.VEXA_DENO_ARGS, JSON.stringify(process.argv.slice(2)), "utf8");',
      ""
    ].join("\n"), "utf8");
    await chmod(fakeDeno, 0o755);

    const previousPath = process.env["PATH"];
    const previousArgsFile = process.env["VEXA_DENO_ARGS"];
    process.env["PATH"] = `${dir}${previousPath ? `:${previousPath}` : ""}`;
    process.env["VEXA_DENO_ARGS"] = argsFile;
    try {
      await runCli(["node", "vexa", "run -deno", input]);
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
      if (previousArgsFile === undefined) delete process.env["VEXA_DENO_ARGS"];
      else process.env["VEXA_DENO_ARGS"] = previousArgsFile;
    }

    const denoArgs = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    expect(denoArgs[0]).toBe("run");
    expect(denoArgs[1]).toBe("-A");
    expect(denoArgs[2]?.startsWith(`${input}.vexa-run-`)).toBe(true);
    expect(denoArgs[2]?.endsWith(".mjs")).toBe(true);
    await expect(readFile(denoArgs[2]!)).rejects.toThrow();
  });

  it("uses TypeScript semantic analysis for JavaScript emission without transpile-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-typescript-semantics-"));
    const validInput = join(dir, "valid.ts");
    const invalidInput = join(dir, "invalid.ts");
    const jsOutput = join(dir, "valid.js");
    await writeFile(
      validInput,
      [
        "class Parent { value(offset = 0): number { return 1 + offset; } }",
        "class Child extends Parent { value(offset = 0): number { return 2 + offset; } }",
        "console.log(new Child().value());",
      ].join("\n"),
      "utf8"
    );
    await writeFile(invalidInput, "const value: string = 1;\nconsole.log(value);", "utf8");

    await runCli(["node", "vexa", "build", validInput, "--out", jsOutput]);

    expect((await readFile(jsOutput, "utf8")).length).toBeGreaterThan(0);
    await expect(runCli(["node", "vexa", "build", invalidInput, "--out", join(dir, "invalid.js")]))
      .rejects.toThrow("TypeScript semantic analysis failed");
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
    expect(outputCode).toContain("const suffix = '-from-js';");
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

  it("bundle command can preserve Node builtins through a createRequire bridge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-node-bundle-"));
    const input = join(dir, "main.ts");
    const output = join(dir, "node-bundle.js");
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await writeFile(
      input,
      'import { basename } from "node:path"\nexport const bundled = basename("/tmp/compiler.ts")\n',
      "utf8"
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCli([
      "node",
      "vexa",
      "bundle",
      input,
      "--out",
      output,
      "--platform",
      "node",
      "--transpile-only"
    ]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).toContain('from "node:module"');
    const imported = await import(`${pathToFileURL(output).href}?${Date.now()}`) as { bundled: string };
    expect(imported.bundled).toBe("compiler.ts");
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Bundled:");
  });

  it("build command turns a project directory into a static dist with copied assets and mappings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-build-dir-"));
    await mkdir(join(dir, "public", "assets"), { recursive: true });
    await mkdir(join(dir, "vendor"), { recursive: true });
    await writeFile(join(dir, "main.vx"), 'console.log("built site")\n', "utf8");
    await writeFile(join(dir, "index.html"), "<!doctype html><html><body><img src=\"assets/logo.svg\" /><script src=\"vendor/runtime.js\"></script><script type=\"module\" src=\"%VEXA_ENTRYPOINT%\"></script></body></html>", "utf8");
    await writeFile(join(dir, "styles.css"), "body { color: red; }\n", "utf8");
    await writeFile(join(dir, "public", "assets", "logo.svg"), "<svg>logo</svg>\n", "utf8");
    await writeFile(join(dir, "vendor", "runtime.js"), "window.runtimeLoaded = true;\n", "utf8");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({
      entrypoint: "main.vx",
      serveMappings: {
        "public/assets": "assets",
        "vendor/runtime.js": "vendor/runtime.js"
      }
    }), "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "build", dir]);

    const distDir = join(dir, "dist");
    expect(await readdir(distDir)).toContain("index.html");
    expect(await readdir(distDir)).toContain("main.js");
    expect(await readdir(distDir)).toContain("styles.css");
    expect(await readFile(join(distDir, "index.html"), "utf8")).toContain('src="main.js"');
    expect(await readFile(join(distDir, "styles.css"), "utf8")).toContain("body { color: red; }");
    expect(await readFile(join(distDir, "main.js"), "utf8")).toContain('console.log("built site");');
    expect(await readFile(join(distDir, "assets", "logo.svg"), "utf8")).toContain("<svg>logo</svg>");
    expect(await readFile(join(distDir, "vendor", "runtime.js"), "utf8")).toContain("window.runtimeLoaded = true;");
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain(`Built: ${dir} -> ${distDir}`);
  });

  it("build command uses vexascript.json outDir when building a project directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-build-dir-outdir-"));
    await writeFile(join(dir, "main.vx"), 'console.log("custom out dir")\n', "utf8");
    await writeFile(join(dir, "index.html"), "<script type=\"module\" src=\"%VEXA_ENTRYPOINT%\"></script>", "utf8");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({
      entrypoint: "main.vx",
      outDir: "site-output"
    }), "utf8");

    await runCli(["node", "vexa", "build", dir]);

    expect(await readFile(join(dir, "site-output", "index.html"), "utf8")).toContain('src="main.js"');
    expect(await readFile(join(dir, "site-output", "main.js"), "utf8")).toContain('console.log("custom out dir");');
  });

  it("bundle command builds configured project directories like build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-bundle-dir-"));
    await writeFile(join(dir, "main.vx"), 'console.log("bundled project")\n', "utf8");
    await writeFile(join(dir, "index.html"), "<script type=\"module\" src=\"%VEXA_ENTRYPOINT%\"></script>", "utf8");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({ entrypoint: "main.vx" }), "utf8");

    await runCli(["node", "vexa", "bundle", dir]);

    const distDir = join(dir, "dist");
    expect(await readFile(join(distDir, "index.html"), "utf8")).toContain('src="main.js"');
    expect(await readFile(join(distDir, "main.js"), "utf8")).toContain('console.log("bundled project");');
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
      expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toBe(`Bundling ${entry}...`);
      expect(String(logSpy.mock.calls[1]?.[0] ?? "")).toContain(`Serving at http://localhost:${session.port} -- `);
      expect(String(logSpy.mock.calls[1]?.[0] ?? "")).toContain(dir);
      expect(/^Bundled in [\d.]+ms \(parse [\d.]+ms, analysis [\d.]+ms, emit [\d.]+ms\)$/.test(String(logSpy.mock.calls[2]?.[0] ?? ""))).toBe(true);

      const baseUrl = `http://127.0.0.1:${session.port}`;
      const htmlText = await fetchText(baseUrl);
      expect(htmlText).toContain("/__vexa_bundle__.js");
      expect(htmlText).toContain("/__vexa_live_reload");

      const initialBundle = await fetchText(`${baseUrl}/__vexa_bundle__.js`);
      expect(initialBundle).toContain('console.log("hello");');

      let markReady!: () => void;
      const ready = new Promise<void>((resolvePromise) => {
        markReady = resolvePromise;
      });
      const reloadPromise = readSseEvent(`${baseUrl}/__vexa_live_reload`, "reload", { waitForReady: true, onReady: markReady });
      await ready;
      await writeFile(entry, 'console.log("updated")\n', "utf8");
      expect(await reloadPromise).toBeTruthy();
      expect(/^Bundled in [\d.]+ms \(parse [\d.]+ms, analysis [\d.]+ms, emit [\d.]+ms\)$/.test(String(logSpy.mock.calls.at(-1)?.[0] ?? ""))).toBe(true);

      const updatedBundle = await fetchText(`${baseUrl}/__vexa_bundle__.js`);
      expect(updatedBundle).toContain('console.log("updated");');
    } finally {
      logSpy.mockRestore();
      if (session) {
        await session.close();
      }
    }
  });

  it("type-checks serve bundles by default and allows an explicit opt-out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-serve-type-check-"));
    const entry = join(dir, "main.vx");
    const html = join(dir, "index.html");
    await writeFile(entry, 'const value: string = 42\nconsole.log(value)\n', "utf8");
    await writeFile(html, '<script type="module" src="%VEXA_ENTRYPOINT%"></script>', "utf8");

    const errors: string[] = [];
    await expect(startServeSession({
      rootDir: dir,
      bundleInput: entry,
      port: 0,
      onDiagnosticError: (result) => errors.push(...result.errors)
    })).rejects.toThrow(`Compilation failed for ${entry}`);
    expect(errors.some((message) => message.includes("not assignable to type 'string'"))).toBe(true);

    const session = await startServeSession({
      rootDir: dir,
      bundleInput: entry,
      port: 0,
      typeCheck: false
    });
    try {
      expect(await fetchText(`http://127.0.0.1:${session.port}/__vexa_bundle__.js`)).toContain("console.log(value)");
    } finally {
      await session.close();
    }
  });

  it("serve command replaces a Vite-style VexaScript entrypoint with the generated bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-serve-vite-entry-"));
    const entry = join(dir, "src", "main.vx");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(entry, 'console.log("vite-compatible")\n', "utf8");
    await writeFile(
      join(dir, "index.html"),
      '<!doctype html><html><body><script type="module" src="/src/main.vx"></script></body></html>',
      "utf8"
    );

    const session = await startServeSession({ rootDir: dir, bundleInput: entry, port: 0 });
    try {
      const htmlText = await fetchText(`http://127.0.0.1:${session.port}`);
      expect(htmlText).toContain('src="/__vexa_bundle__.js"');
      expect(htmlText).not.toContain('src="/src/main.vx"');
    } finally {
      await session.close();
    }
  });

  it("serve command exposes the conventional public directory at the URL root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-serve-public-"));
    const entry = join(dir, "src", "main.vx");
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "public", "assets"), { recursive: true });
    await writeFile(entry, 'console.log("public")\n', "utf8");
    await writeFile(join(dir, "index.html"), '<script type="module" src="/src/main.vx"></script>', "utf8");
    await writeFile(join(dir, "root-only.txt"), "root fallback\n", "utf8");
    await writeFile(join(dir, "public", "assets", "logo.svg"), "<svg>public</svg>\n", "utf8");

    const session = await startServeSession({ rootDir: dir, bundleInput: entry, port: 0 });
    try {
      expect(await fetchText(`http://127.0.0.1:${session.port}/assets/logo.svg`)).toContain("<svg>public</svg>");
      expect(await fetchText(`http://127.0.0.1:${session.port}/root-only.txt`)).toContain("root fallback");
    } finally {
      await session.close();
    }
  });

  it("serve command accepts --open and opens the served URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-serve-open-"));
    const entry = join(dir, "main.vx");
    const html = join(dir, "index.html");
    const openedUrlFile = join(dir, "opened-url.txt");
    const browserScript = join(dir, "fake-browser.mjs");
    await writeFile(entry, 'console.log("hello")\n', "utf8");
    await writeFile(html, "<!doctype html><html><body><script type=\"module\" src=\"%VEXA_ENTRYPOINT%\"></script></body></html>", "utf8");
    await writeFile(browserScript, [
      "#!/usr/bin/env node",
      "import { writeFile } from \"node:fs/promises\";",
      "const outputPath = process.env.BROWSER_LOG;",
      "if (!outputPath) {",
      "  console.error(\"Missing BROWSER_LOG\");",
      "  process.exit(1);",
      "}",
      "writeFile(outputPath, `${process.argv[2] ?? \"\"}\\n`, \"utf8\").then(() => process.exit(0), (error) => {",
      "  console.error(error instanceof Error ? error.message : String(error));",
      "  process.exit(1);",
      "});"
    ].join("\n"), "utf8");
    await chmod(browserScript, 0o755);

    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--import",
      resolve(process.cwd(), "scripts/registerTextModuleLoader.cjs"),
      "cli/cli.ts",
      "serve",
      dir,
      "--bundle",
      entry,
      "--port",
      "0",
      "--open"
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BROWSER: browserScript,
        BROWSER_LOG: openedUrlFile
      },
      stdio: ["ignore", "pipe", "pipe"]
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

    try {
      const openedUrl = await new Promise<string>((resolvePromise, reject) => {
        const startedAt = Date.now();
        const check = () => {
          const retry = () => {
            if (Date.now() - startedAt > 10000) {
              reject(new Error(`Timed out waiting for browser open.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
              return;
            }
            setTimeout(check, 50);
          };
          void readFile(openedUrlFile, "utf8").then(
            (content) => {
              const openedUrl = content.trim();
              if (openedUrl.length > 0) {
                resolvePromise(openedUrl);
                return;
              }
              retry();
            },
            retry
          );
        };
        check();
      });

      const opened = new URL(openedUrl);
      expect(opened.protocol).toBe("http:");
      expect(opened.hostname).toBe("localhost");
      expect(Number.parseInt(opened.port, 10) > 0).toBe(true);
      expect(stdout).toContain("Serving at http://localhost:");
    } finally {
      const closed = child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolvePromise) => {
            child.once("close", () => resolvePromise());
          });
      child.kill();
      await closed;
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

  it("lists only JavaScript generation commands in CLI help", async () => {
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["node", "vexa", "--help"]);

    const help = stdoutWriteSpy.mock.calls.map((call) => String(call[0] ?? "")).join("");
    expect(help).toContain("build [options] [input]");
    expect(help).toContain("bundle [options] [input]");
    expect(help).toContain("serve [options] [dir]");
    expect(help).not.toContain("cpp [options]");
  });

  it("prints JavaScript build help", async () => {
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((...args: unknown[]) => {
      throw new Error("process.exit:" + (typeof args[0] === "number" ? args[0] : 0));
    });

    await expect(runCli(["node", "vexa", "help", "build"])).rejects.toThrow("process.exit:0");
    const buildHelp = stdoutWriteSpy.mock.calls.map((call) => String(call[0] ?? "")).join("");
    expect(buildHelp).toContain("Usage: vexa build [options] [input]");
    expect(buildHelp).not.toContain("--emit");
  });

  it("documents serve type checking as the default with an explicit opt-out", async () => {
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((...args: unknown[]) => {
      throw new Error("process.exit:" + (typeof args[0] === "number" ? args[0] : 0));
    });

    await expect(runCli(["node", "vexa", "help", "serve"])).rejects.toThrow("process.exit:0");
    const serveHelp = stdoutWriteSpy.mock.calls.map((call) => String(call[0] ?? "")).join("");
    expect(serveHelp).toContain("--no-type-check");
    expect(/^\s+--type-check\b/m.test(serveHelp)).toBe(false);
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

  it("root launcher starts the source CLI with text-module imports enabled", async () => {
    const run = await runCommandCapture(resolve(process.cwd(), "vexa"), [], { cwd: process.cwd() });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Usage: vexa [options] [command]");
    expect(run.stdout).toContain("build [options] [input]");
    expect(run.stdout).toContain("bundle [options] [input]");
    expect(run.stdout).toContain("serve [options] [dir]");
    expect(run.stderr).toBe("");
  });

  it("built CLI starts without unsettled top-level await warnings", async () => {
    const distPath = join(process.cwd(), "dist");
    await rm(distPath, { recursive: true, force: true });

    const build = await buildBundledCli();
    expect(build.code).toBe(0);
    expect(build.stderr).toBe("");

    const run = await runCommandCapture(process.execPath, ["dist/vexa.js", "--version"], { cwd: process.cwd() });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(COMPILER_VERSION);
    expect(run.stderr).not.toContain("Detected unsettled top-level await");
  });

  it("bundled LSP server has no module-scope top-level await", async () => {
    // Regression: a single module-scope `await` (e.g. the former import-time
    // declaration preload) makes the whole ESM bundle a top-level-await module.
    // esbuild then emits `await init_<module>()` at column 0, Node reports
    // "Detected unsettled top-level await", and the packaged extension server
    // exits with code 13 in a restart loop. The server must bundle without one.
    const dir = await mkdtemp(join(tmpdir(), "vexa-lsp-bundle-"));
    const outfile = join(dir, "vexa.mjs");
    await buildWithEsbuild({
      entryPoints: ["compiler/lsp/server.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      outfile,
      external: [
        "vscode-languageserver",
        "vscode-languageserver/node.js",
        "vscode-languageserver-textdocument"
      ],
      logLevel: "silent",
      plugins: [textModulePlugin()]
    });

    const bundle = await readFile(outfile, "utf8");
    // Module-scope statements are emitted at column 0; awaits inside function
    // bodies are indented, so a line that begins with `await ` is a top-level
    // await.
    const topLevelAwaitLines = bundle.split("\n").filter((line) => /^await\b/.test(line));
    expect(topLevelAwaitLines).toEqual([]);

    await rm(dir, { recursive: true, force: true });
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

    const run = await runCommandCapture(process.execPath, ["dist/vexa.js"], { cwd: process.cwd() });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Usage: vexa [options] [command]");
    expect(run.stdout).not.toContain("cpp <input>");
    expect(run.stderr).toBe("");
  });

  it("built CLI prints command-specific build help", async () => {
    const distPath = join(process.cwd(), "dist");
    await rm(distPath, { recursive: true, force: true });

    const build = await buildBundledCli();
    expect(build.code).toBe(0);

    const run = await runCommandCapture(process.execPath, ["dist/vexa.js", "help", "build"], { cwd: process.cwd() });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Usage: vexa build [options] [input]");
    expect(run.stdout).not.toContain("--emit <language>");
    expect(run.stderr).toBe("");
  });

  it("built CLI runs sample programs and preserves stdout", async () => {
    const distPath = join(process.cwd(), "dist");
    await rm(distPath, { recursive: true, force: true });

    const build = await buildBundledCli();
    expect(build.code).toBe(0);

    const run = await runCommandCapture(
      process.execPath,
      ["dist/vexa.js", "run", "samples/node/main.vx"],
      { cwd: process.cwd() }
    );
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

  it("test command discovers and executes .test.vx files with Node's test runner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-tests-"));
    const testFile = join(dir, "math.test.vx");
    await writeFile(testFile, 'test("arithmetic") { assert(1 + 1 == 2) }', "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "test", dir]);

    const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("arithmetic");
    expect(logs).toContain("1 test file passed");
  });

  it("test command preserves explicit Node test imports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-tests-"));
    const nodeTypesDir = join(dir, "node_modules", "@types", "node");
    await mkdir(nodeTypesDir, { recursive: true });
    await writeFile(
      join(nodeTypesDir, "package.json"),
      JSON.stringify({ name: "@types/node", types: "index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(nodeTypesDir, "index.d.ts"),
      `declare module "node:test" {
        function test(name?: string, fn?: TestFn): Promise<void>;
        function test(fn?: TestFn): Promise<void>;
        namespace test {
          export { test };
        }
        namespace test {
          type TestFn = (context: TestContext) => void | Promise<void>;
          interface TestContext {}
        }
      }`,
      "utf8"
    );
    const testFile = join(dir, "node-import.test.vx");
    await writeFile(
      testFile,
      'import { test } from "node:test"\n\ntest("explicit import") {\n}',
      "utf8"
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "vexa", "test", testFile]);

    const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("explicit import");
    expect(logs).toContain("1 test file passed");
  });

  it("test command fails when an inline assertion fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-tests-"));
    const testFile = join(dir, "failure.test.vx");
    await writeFile(testFile, 'test("failure", () => { assert(false, "expected true") })', "utf8");

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
