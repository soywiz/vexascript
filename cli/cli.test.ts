import { afterEach, describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, readFile, readdir, rm, spawn, tmpdir, vi, writeFile } from "../compiler/test/expect";
import { createServer as createNetServer } from "node:net";
import { chmod } from "node:fs/promises";
import { ensureLspTransportArg, runCli } from "./cli";
import { startServeSession } from "./cliServe";
import { COMPILER_VERSION } from "../compiler/compilerVersion";
import { runCommandCapture } from "./io";

async function buildBundledCli(): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return await runCommandCapture(
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
    { cwd: process.cwd() }
  );
}

async function readSseEvent(url: string, eventName: string, options: { waitForReady?: boolean } = {}): Promise<string> {
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

  it("build command emits C++ without a JavaScript source map", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-cpp-"));
    const input = join(dir, "input.vx");
    const output = join(dir, "output.cpp");
    await writeFile(input, "for (n of 0 ..< 10) { console.log(n) }", "utf8");

    await runCli(["node", "vexa", "build", input, "--emit", "cpp", "--out", output]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode.length).toBeGreaterThan(0);
    await expect(readFile(`${output}.map`, "utf8")).rejects.toThrow();
  });

  it("cpp command emits a C++ translation unit without compiling it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-cpp-command-"));
    const input = join(dir, "input.vx");
    const output = join(dir, "output.cpp");
    await writeFile(input, "console.log('cpp')", "utf8");

    await runCli(["node", "vexa", "cpp", input, "--out", output]);

    const outputCode = await readFile(output, "utf8");
    expect(outputCode).toContain('#include "runtime.cpp"');
    expect(outputCode).toContain('vexa::console.log(runtime.string("cpp"));');
    await expect(readFile(`${output}.map`, "utf8")).rejects.toThrow();
  });

  it("executable command routes inputs through native executable validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-executable-command-"));
    const input = join(dir, "input.ts");
    await writeFile(input, "console.log('native')", "utf8");

    await expect(runCli(["node", "vexa", "executable", input])).rejects.toThrow(
      "Native compilation expects a .vx input file"
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

      const reloadPromise = readSseEvent(`${baseUrl}/__vexa_live_reload`, "reload", { waitForReady: true });
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

    const child = spawn(process.execPath, ["--import", "tsx", "cli/cli.ts", "serve", dir, "--bundle", entry, "--port", "0", "--open"], {
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
          void readFile(openedUrlFile, "utf8").then(
            (content) => resolvePromise(content.trim()),
            () => {
              if (Date.now() - startedAt > 10000) {
                reject(new Error(`Timed out waiting for browser open.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
                return;
              }
              setTimeout(check, 50);
            }
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
      child.kill();
      await new Promise<void>((resolvePromise) => {
        child.once("close", () => resolvePromise());
      });
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

  it("lists the direct C++ and executable commands in CLI help", async () => {
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["node", "vexa", "--help"]);

    const help = stdoutWriteSpy.mock.calls.map((call) => String(call[0] ?? "")).join("");
    expect(help).toContain("cpp [options] <input>");
    expect(help).toContain("executable [options] <input>");
    expect(help).toContain("native [options] <input>");
  });

  it("prints command-specific build, cpp, executable, and native help", async () => {
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((...args: unknown[]) => {
      throw new Error(`process.exit:${typeof args[0] === "number" ? args[0] : 0}`);
    });

    await expect(runCli(["node", "vexa", "help", "build"])).rejects.toThrow("process.exit:0");
    const buildHelp = stdoutWriteSpy.mock.calls.map((call) => String(call[0] ?? "")).join("");
    expect(buildHelp).toContain("Usage: vexa build [options] <input>");
    expect(buildHelp).toContain("--emit <language>");
    expect(buildHelp).toContain("--native");

    await expect(runCli(["node", "vexa", "cpp", "--help"])).rejects.toThrow("process.exit:0");
    const cppHelp = stdoutWriteSpy.mock.calls.map((call) => String(call[0] ?? "")).join("");
    expect(cppHelp).toContain("Usage: vexa cpp [options] <input>");
    expect(cppHelp).toContain("--jsx-factory <factory>");

    await expect(runCli(["node", "vexa", "executable", "--help"])).rejects.toThrow("process.exit:0");
    const executableHelp = stdoutWriteSpy.mock.calls.map((call) => String(call[0] ?? "")).join("");
    expect(executableHelp).toContain("Usage: vexa executable [options] <input>");
    expect(executableHelp).toContain("--build-dir <dir>");

    await expect(runCli(["node", "vexa", "native", "--help"])).rejects.toThrow("process.exit:0");
    const nativeHelp = stdoutWriteSpy.mock.calls.map((call) => String(call[0] ?? "")).join("");
    expect(nativeHelp).toContain("Usage: vexa native [options] <input>");
    expect(nativeHelp).toContain("--build-dir <dir>");
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
    const build = await runCommandCapture(
      process.execPath,
      [
        "node_modules/esbuild/bin/esbuild",
        "compiler/lsp/server.ts",
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node20",
        `--outfile=${outfile}`,
        "--external:vscode-languageserver",
        "--external:vscode-languageserver/node.js",
        "--external:vscode-languageserver-textdocument",
        "--log-level=error",
      ],
      { cwd: process.cwd() }
    );
    expect(build.code).toBe(0);
    expect(build.stderr).toBe("");

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
    expect(run.stderr).toBe("");
  });

  it("built CLI prints command-specific build help", async () => {
    const distPath = join(process.cwd(), "dist");
    await rm(distPath, { recursive: true, force: true });

    const build = await buildBundledCli();
    expect(build.code).toBe(0);

    const run = await runCommandCapture(process.execPath, ["dist/vexa.js", "help", "build"], { cwd: process.cwd() });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Usage: vexa build [options] <input>");
    expect(run.stdout).toContain("--emit <language>");
    expect(run.stdout).toContain("--native");
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
