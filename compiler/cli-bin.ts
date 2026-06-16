import "./localVfs";
import { spawn } from "node:child_process";
import { COMPILER_VERSION } from "./compilerVersion";
import { LANGUAGE_CLI_BIN } from "./language";
import { fileExists } from "./utils/fs";
import { pathToFileURL, resolve } from "./utils/path";

const CLI_HELP_TEXT = [
  `Usage: ${LANGUAGE_CLI_BIN} [options] [command]`,
  "",
  "Commands:",
  "  build <input>     Compile a VexaScript file",
  "  bundle <input>    Bundle a VexaScript entry file and its local modules as ESM",
  "  run <input>       Transpile and run a VexaScript file with Node.js",
  `  test [paths...]    Discover and run .test.vx files`,
  "  tokens <input>    Show file tokens",
  "  ast <input>       Show simplified AST",
  "  format <input>    Format a VexaScript file",
  "  syntax            Print syntax bundle output",
  "  lsp               Start the language server",
  "  mcp               Start the MCP server",
  "",
  "Options:",
  "  -V, --version     Output the compiler version",
  "  -h, --help        Display help",
].join("\n");

function isVersionRequest(argv: string[]): boolean {
  return argv.includes("--version") || argv.includes("-V");
}

function isHelpRequest(argv: string[]): boolean {
  return argv.length <= 2
    || argv.includes("--help")
    || argv.includes("-h")
    || argv[2] === "help";
}

async function runSourceCliIfAvailable(argv: string[]): Promise<boolean> {
  const sourceCliPath = resolve(process.cwd(), "compiler", "cli.ts");
  const tsxLoaderPath = resolve(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs");
  if (!(await fileExists(sourceCliPath)) || !(await fileExists(tsxLoaderPath))) {
    return false;
  }

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", sourceCliPath, ...argv.slice(2)], {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`Source CLI exited with code ${code ?? 1}`));
    });
  });
  return true;
}

async function main(argv: string[] = process.argv): Promise<void> {
  if (isVersionRequest(argv)) {
    process.stdout.write(`${COMPILER_VERSION}\n`);
    return;
  }
  if (isHelpRequest(argv)) {
    process.stdout.write(`${CLI_HELP_TEXT}\n`);
    return;
  }

  if (await runSourceCliIfAvailable(argv)) {
    return;
  }

  (globalThis as { __vexaCliBootstrappedEntry?: boolean }).__vexaCliBootstrappedEntry = true;
  const builtCliModuleHref = process.argv[1]?.endsWith("dist/vexa.js")
    ? pathToFileURL(process.argv[1].replace(/vexa\.js$/, "cli.js")).href
    : null;
  const { runCli, DiagnosticError } = builtCliModuleHref
    ? await import(builtCliModuleHref)
    : await import("./cli");
  try {
    await runCli(argv);
  } catch (error) {
    if (!(error instanceof DiagnosticError)) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  }
}

// Keep the process alive while the dynamic CLI import resolves; otherwise the
// bundled entry can exit before the Promise-only bootstrap finishes.
const bootstrapKeepAlive = setTimeout(() => undefined, 1 << 30);

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(bootstrapKeepAlive);
    if ((process.exitCode ?? 0) !== 0) {
      process.exit(process.exitCode ?? 1);
    }
  });
