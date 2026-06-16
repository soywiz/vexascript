import "./localVfs";
import { Command } from "commander";
import type { TranspileDiagnostic, TranspileTarget } from "../compiler/runtime/transpile";
import { LANGUAGE_CLI_BIN, LANGUAGE_FILE_EXTENSION, replaceLanguageExtension } from "../compiler/language";
import { loadProject } from "../compiler/project";
import { renderSyntaxTarget, SYNTAX_TARGETS, type SyntaxTarget } from "../compiler/syntax";
import { COMPILER_VERSION } from "../compiler/compilerVersion";
import { basename, dirname, pathToFileURL, resolve } from "../compiler/utils/path";
import { vfs } from "../compiler/vfs";
import {
  ambientDeclarationsForProject,
  createBundledModuleArtifacts,
  ensureCompilerRuntimePrograms,
  ensureRuntimeDependencies,
  resolveServeBundleInput
} from "./cliShared";

/** Thrown when diagnostics have already been printed; the top-level handler should exit silently. */
export class DiagnosticError extends Error {
  constructor() { super("Compilation failed"); this.name = "DiagnosticError"; }
}

function printDiagnostic(diag: TranspileDiagnostic, useColor: boolean): void {
  const c = useColor
    ? {
        cyan: "\x1b[36m",
        red: "\x1b[1;31m",
        gray: "\x1b[90m",
        yellow: "\x1b[33m",
        reset: "\x1b[0m"
      }
    : { cyan: "", red: "", gray: "", yellow: "", reset: "" };

  const location = `${diag.file}:${diag.line}:${diag.column}`;
  const header = `${c.cyan}${location}${c.reset} - ${c.red}error${c.reset} ${c.gray}${diag.code}${c.reset}: ${diag.message}`;
  console.error(header);

  if (diag.sourceLine) {
    const lineNum = String(diag.line);
    const underlineStart = diag.column - 1;
    const underlineLen = Math.max(1, diag.endColumn - diag.column);
    const underline = " ".repeat(lineNum.length + 1 + underlineStart) + "~".repeat(underlineLen);
    console.error(`${c.yellow}${lineNum}${c.reset} ${diag.sourceLine}`);
    console.error(`${c.red}${underline}${c.reset}`);
  }
}

function printDiagnostics(result: { errors: string[]; diagnostics?: TranspileDiagnostic[] }, file: string): void {
  const useColor = process.stderr.isTTY ?? false;
  if (result.diagnostics && result.diagnostics.length > 0) {
    for (const diag of result.diagnostics) {
      printDiagnostic(diag, useColor);
    }
  } else {
    for (const error of result.errors) {
      const atMatch = error.match(/^(.*) at (\d+:\d+)$/);
      if (atMatch) {
        console.error(`${file}:${atMatch[2]} error: ${atMatch[1]}`);
      } else {
        console.error(`${file}: error: ${error}`);
      }
    }
  }
}

async function runLanguageServer(): Promise<void> {
  await import("../compiler/lsp/server");
}

function hasLspTransportArg(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--stdio" || arg === "--node-ipc" || arg.startsWith("--socket")) {
      return true;
    }
  }
  return false;
}

export function ensureLspTransportArg(argv: string[]): string[] {
  if (hasLspTransportArg(argv)) {
    return argv;
  }
  return [...argv, "--stdio"];
}

async function buildFile(
  input: string,
  out?: string,
  target: TranspileTarget = "optimized",
  jsxOptions: { jsxFactory?: string; jsxFragmentFactory?: string } = {}
): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const source = (await vfs().readFile(sourcePath))!;
  const project = await loadProject(sourcePath);
  const outputPath = resolve(process.cwd(), out ?? replaceLanguageExtension(input, ".js"));
  await ensureCompilerRuntimePrograms();
  const ambientDeclarations = await ambientDeclarationsForProject(project);
  const { transpile } = await import("../compiler/runtime/transpile");
  const result = transpile(source, {
    sourceFilePath: sourcePath,
    outputFilePath: outputPath,
    target,
    ambientDeclarations,
    rewriteImportExtensions: true,
    ...(project?.jsxFactory ? { jsxFactory: project.jsxFactory } : {}),
    ...(project?.jsxFragmentFactory ? { jsxFragmentFactory: project.jsxFragmentFactory } : {}),
    ...(jsxOptions.jsxFactory ? { jsxFactory: jsxOptions.jsxFactory } : {}),
    ...(jsxOptions.jsxFragmentFactory ? { jsxFragmentFactory: jsxOptions.jsxFragmentFactory } : {})
  });
  if (result.errors.length > 0) {
    printDiagnostics(result, sourcePath);
    throw new Error(`Compilation failed for ${sourcePath}`);
  }

  let outputCode = result.code;
  if (result.sourceMap) {
    const sourceMapPath = `${outputPath}.map`;
    const sourceMapFileName = basename(sourceMapPath);
    await vfs().writeFile(sourceMapPath, result.sourceMap);
    outputCode = `${outputCode}\n//# sourceMappingURL=${sourceMapFileName}`;
  }
  await vfs().writeFile(outputPath, outputCode);

  console.log(`Compiled: ${sourcePath} -> ${outputPath}`);
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`warning: ${warning}`);
    }
  }
}

async function bundleFile(
  input: string,
  out?: string,
  target: TranspileTarget = "optimized",
  jsxOptions: { jsxFactory?: string; jsxFragmentFactory?: string } = {}
): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const project = await loadProject(sourcePath);
  await ensureRuntimeDependencies(sourcePath, project);
  await ensureCompilerRuntimePrograms();

  const outputPath = resolve(process.cwd(), out ?? replaceLanguageExtension(input, ".js"));
  const result = await createBundledModuleArtifacts(sourcePath, target, project, jsxOptions);
  if (result.errors.length > 0) {
    printDiagnostics(result, sourcePath);
    throw new Error(`Compilation failed for ${sourcePath}`);
  }

  await vfs().writeFile(outputPath, result.code);
  console.log(`Bundled: ${sourcePath} -> ${outputPath}`);
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`warning: ${warning}`);
    }
  }
}

export async function runFile(input: string, target: TranspileTarget = "conservative"): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const project = await loadProject(sourcePath);
  await ensureRuntimeDependencies(sourcePath, project);
  await ensureCompilerRuntimePrograms();
  const result = await createBundledModuleArtifacts(sourcePath, target, project, {}, {
    externalDependencyStrategy: "node-require"
  });
  await executeCompiled({ code: result.code, warnings: result.warnings, errors: result.errors, diagnostics: result.diagnostics }, sourcePath);
}

async function executeSource(source: string, sourcePath: string, target: TranspileTarget): Promise<void> {
  const outputPath = replaceLanguageExtension(sourcePath, ".js");
  const project = await loadProject(sourcePath);
  await ensureCompilerRuntimePrograms();
  const ambientDeclarations = await ambientDeclarationsForProject(project);
  const { transpile } = await import("../compiler/runtime/transpile");
  const result = transpile(source, {
    sourceFilePath: sourcePath,
    outputFilePath: outputPath,
    target,
    preserveSourceLineOffsets: true,
    ambientDeclarations,
    ...(project?.jsxFactory ? { jsxFactory: project.jsxFactory } : {}),
    ...(project?.jsxFragmentFactory ? { jsxFragmentFactory: project.jsxFragmentFactory } : {})
  });
  await executeCompiled(result, sourcePath);
}

async function executeCompiled(
  result: { code: string; warnings: string[]; errors: string[]; sourceMap?: string; diagnostics?: TranspileDiagnostic[] },
  sourcePath: string
): Promise<void> {
  if (result.errors.length > 0) {
    printDiagnostics(result, sourcePath);
    throw new DiagnosticError();
  }
  const inlineSourceMap = result.sourceMap
    ? `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(result.sourceMap, "utf8").toString("base64")}`
    : "";
  const jsToExecute = `${result.code}${inlineSourceMap}\n//# sourceURL=${sourcePath}`;
  // Write a temp file next to the source so Node.js resolves node_modules from
  // the source's directory when the compiled code contains bare specifier imports.
  const tmpPath = resolve(dirname(sourcePath), `.vexa-run-${process.pid}-${Date.now()}.mjs`);
  try {
    await vfs().writeFile(tmpPath, jsToExecute);
    await import(pathToFileURL(tmpPath).href);
  } finally {
    await vfs().unlink(tmpPath).catch(() => undefined);
  }

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`warning: ${warning}`);
    }
  }
}

async function runTests(paths: string[]): Promise<void> {
  const { runVexaScriptTests } = await import("./testRunner");
  const result = await runVexaScriptTests(paths, async (source, testFile) => {
    await executeSource(source, testFile, "conservative");
    console.log(`Passed: ${testFile}`);
  });
  console.log(`${result.testFiles.length} test file${result.testFiles.length === 1 ? "" : "s"} passed`);
}

async function printTokens(input: string): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const source = await vfs().readFile(sourcePath);
  const { tokenize } = await import("../compiler/runtime/tooling");
  console.log(JSON.stringify(tokenize(source), null, 2));
}

async function printAst(input: string): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const source = await vfs().readFile(sourcePath);
  const { toAstPreview } = await import("../compiler/runtime/tooling");
  console.log(JSON.stringify(toAstPreview(source), null, 2));
}

async function formatFile(input: string, opts: { write?: boolean; out?: string }): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const source = await vfs().readFile(sourcePath);
  const { format } = await import("../compiler/runtime/tooling");
  const formatted = format(source);
  const formattedWithTrailingNewline = `${formatted}\n`;

  await vfs().writeFile(sourcePath, formattedWithTrailingNewline);
  if (opts.out) {
    const outputPath = resolve(process.cwd(), opts.out);
    await vfs().writeFile(outputPath, formattedWithTrailingNewline);
    console.log(`Formatted: ${sourcePath} (and wrote copy to ${outputPath})`);
    return;
  }

  console.log(`Formatted: ${sourcePath}`);
}

function resolveSyntaxTarget(opts: {
  target?: string;
  monaco?: boolean;
  monacoLanguage?: boolean;
  monacoConfiguration?: boolean;
  vscode?: boolean;
  vscodeGrammar?: boolean;
  vscodeConfiguration?: boolean;
  codemirror?: boolean;
  textmate?: boolean;
}): SyntaxTarget {
  const requestedTargets = [
    opts.monaco ? "monaco" : undefined,
    opts.monacoLanguage ? "monaco-language" : undefined,
    opts.monacoConfiguration ? "monaco-configuration" : undefined,
    opts.vscode ? "vscode-grammar" : undefined,
    opts.vscodeGrammar ? "vscode-grammar" : undefined,
    opts.vscodeConfiguration ? "vscode-configuration" : undefined,
    opts.codemirror ? "codemirror-legacy" : undefined,
    opts.textmate ? "textmate" : undefined,
    opts.target,
  ].filter((target): target is string => target !== undefined);

  if (requestedTargets.length === 0) {
    return "monaco";
  }
  if (requestedTargets.length > 1) {
    throw new Error(`Syntax output expects exactly one target. Supported targets: ${SYNTAX_TARGETS.join(", ")}`);
  }

  const requestedTarget = requestedTargets[0];
  if (SYNTAX_TARGETS.includes(requestedTarget as SyntaxTarget)) {
    return requestedTarget as SyntaxTarget;
  }

  throw new Error(`Unsupported syntax target "${requestedTarget}". Supported targets: ${SYNTAX_TARGETS.join(", ")}`);
}

async function printSyntax(opts: {
  target?: string;
  monaco?: boolean;
  monacoLanguage?: boolean;
  monacoConfiguration?: boolean;
  vscode?: boolean;
  vscodeGrammar?: boolean;
  vscodeConfiguration?: boolean;
  codemirror?: boolean;
  textmate?: boolean;
}): Promise<void> {
  console.log(renderSyntaxTarget(resolveSyntaxTarget(opts)));
}

function createProgram(): Command {
  const program = new Command()
    .name(LANGUAGE_CLI_BIN)
    .description(`VexaScript compiler CLI - ${COMPILER_VERSION} - Soywiz Software 2026`)
    .version(COMPILER_VERSION);

  program
    .command("lsp")
    .description("Start the language server")
    .allowUnknownOption(true)
    .action(async () => {
      const lspArgv = ensureLspTransportArg(process.argv);
      const originalArgv = process.argv;
      process.argv = lspArgv;
      try {
        await runLanguageServer();
      } finally {
        process.argv = originalArgv;
      }
    });

  program
    .command("mcp")
    .description("Start the VexaScript MCP codebase navigation server")
    .option("--root <dir>", "Workspace root used to resolve relative file paths and scan symbols", process.cwd())
    .action(async (opts: { root?: string }) => {
      const { runMcpServer } = await import("./mcpServer");
      await runMcpServer({ cwd: resolve(process.cwd(), opts.root ?? ".") });
    });

  program
    .command("syntax")
    .description("Print embedded VexaScript syntax definitions for editor integrations")
    .option("--target <name>", `Syntax target: ${SYNTAX_TARGETS.join("|")}`)
    .option("--monaco", "Print Monaco-ready bundle source")
    .option("--monaco-language", "Print Monaco Monarch language JSON")
    .option("--monaco-configuration", "Print Monaco language-configuration JSON")
    .option("--vscode", "Print VS Code/TextMate grammar JSON")
    .option("--vscode-grammar", "Print VS Code/TextMate grammar JSON")
    .option("--vscode-configuration", "Print VS Code language-configuration JSON")
    .option("--codemirror", "Print CodeMirror legacy mode source")
    .option("--textmate", "Print TextMate grammar JSON")
    .action(async (opts: {
      target?: string;
      monaco?: boolean;
      monacoLanguage?: boolean;
      monacoConfiguration?: boolean;
      vscode?: boolean;
      vscodeGrammar?: boolean;
      vscodeConfiguration?: boolean;
      codemirror?: boolean;
      textmate?: boolean;
    }) => {
      await printSyntax(opts);
    });

  const resolveBuildOptions = (opts: { target?: string; jsxFactory?: string; jsxFragmentFactory?: string }) => ({
    target: opts.target === "conservative" ? "conservative" as const : "optimized" as const,
    jsxOptions: {
      ...(opts.jsxFactory ? { jsxFactory: opts.jsxFactory } : {}),
      ...(opts.jsxFragmentFactory ? { jsxFragmentFactory: opts.jsxFragmentFactory } : {})
    }
  });

  program
    .command("build")
    .description("Compile a VexaScript file to JavaScript")
    .argument("<input>", "Input file")
    .option("-o, --out <file>", "Output file")
    .option("--target <mode>", "Transpile target mode: conservative|optimized", "optimized")
    .option("--jsx-factory <factory>", "Callee used for embedded XML/JSX elements (default: React.createElement)")
    .option("--jsx-fragment-factory <factory>", "Expression used for JSX fragments (default: React.Fragment)")
    .option("--bundle", "Bundle the entry and all referenced VexaScript, TypeScript, JavaScript, and node_modules packages as ESM")
    .action(async (input: string, opts: { out?: string; target?: string; jsxFactory?: string; jsxFragmentFactory?: string; bundle?: boolean }) => {
      const { target, jsxOptions } = resolveBuildOptions(opts);
      if (opts.bundle) {
        await bundleFile(input, opts.out, target, jsxOptions);
        return;
      }
      await buildFile(input, opts.out, target, jsxOptions);
    });

  program
    .command("bundle")
    .description("Bundle a VexaScript entry file and its resolved local and package modules as ESM")
    .argument("<input>", "Input file")
    .option("-o, --out <file>", "Output file")
    .option("--target <mode>", "Transpile target mode: conservative|optimized", "optimized")
    .option("--jsx-factory <factory>", "Callee used for embedded XML/JSX elements (default: React.createElement)")
    .option("--jsx-fragment-factory <factory>", "Expression used for JSX fragments (default: React.Fragment)")
    .action(async (input: string, opts: { out?: string; target?: string; jsxFactory?: string; jsxFragmentFactory?: string }) => {
      const { target, jsxOptions } = resolveBuildOptions(opts);
      await bundleFile(input, opts.out, target, jsxOptions);
    });

  program
    .command("serve")
    .description("Serve a static folder, inject the bundle into HTML, and live-reload on bundle changes")
    .argument("[dir]", "Folder to serve", ".")
    .option("--bundle <input>", "Bundle entry VexaScript file")
    .option("--port <number>", "HTTP port", "8080")
    .option("--target <mode>", "Transpile target mode: conservative|optimized", "optimized")
    .option("--jsx-factory <factory>", "Callee used for embedded XML/JSX elements (default: React.createElement)")
    .option("--jsx-fragment-factory <factory>", "Expression used for JSX fragments (default: React.Fragment)")
    .action(async (
      dir: string | undefined,
      opts: { bundle?: string; port?: string; target?: string; jsxFactory?: string; jsxFragmentFactory?: string }
    ) => {
      const { target, jsxOptions } = resolveBuildOptions(opts);
      const rootDir = dir ?? ".";
      const { startServeSession } = await import("./cliServe");
      await startServeSession({
        rootDir,
        bundleInput: await resolveServeBundleInput(rootDir, opts.bundle),
        port: Number.parseInt(opts.port ?? "8080", 10),
        target,
        ...jsxOptions,
        onDiagnosticError: printDiagnostics
      });
    });

  program
    .command("run")
    .description("Transpile and run a VexaScript file with Node.js")
    .argument("<input>", "Input file")
    .option("--target <mode>", "Transpile target mode: conservative|optimized", "conservative")
    .action(async (input: string, opts: { target?: string }) => {
      const target = opts.target === "conservative" ? "conservative" : "optimized";
      await runFile(input, target);
    });

  program
    .command("test")
    .description(`Discover and run .test${LANGUAGE_FILE_EXTENSION} files with inline test and assert helpers`)
    .argument("[paths...]", "Test files or directories", [])
    .action(async (paths: string[]) => {
      await runTests(paths);
    });

  program
    .command("tokens")
    .description("Show file tokens")
    .argument("<input>", "Input file")
    .action(async (input: string) => {
      await printTokens(input);
    });

  program
    .command("ast")
    .description("Show simplified AST")
    .argument("<input>", "Input file")
    .action(async (input: string) => {
      await printAst(input);
    });

  program
    .command("format")
    .description("Format a VexaScript file")
    .argument("<input>", "Input file")
    .option("-w, --write", "Deprecated: formatting now always overwrites the input file")
    .option("-o, --out <file>", "Output file")
    .action(async (input: string, opts: { write?: boolean; out?: string }) => {
      await formatFile(input, opts);
    });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  if (argv[2] === LANGUAGE_CLI_BIN) {
    await runCli([argv[0]!, argv[1]!, ...argv.slice(3)]);
    return;
  }

  if (argv.length <= 2 || argv.includes("--help") || argv.includes("-h") || argv[2] === "help") {
    createProgram().outputHelp();
    return;
  }

  if (argv.includes("--language-server") || argv.includes("--lsp")) {
    const lspArgv = ensureLspTransportArg(argv);
    const originalArgv = process.argv;
    process.argv = lspArgv;
    try {
      await runLanguageServer();
    } finally {
      process.argv = originalArgv;
    }
    return;
  }

  const knownCommands = new Set(["build", "bundle", "serve", "run", "test", "tokens", "ast", "format", "syntax", "lsp", "mcp"]);
  const firstArg = argv[2];
  if (firstArg !== undefined && !firstArg.startsWith("-") && !knownCommands.has(firstArg)) {
    const looksLikeFile = firstArg.includes("/") || firstArg.includes(".");
    const existsOnDisk = await vfs().stat(resolve(process.cwd(), firstArg)).then(() => true, () => false);
    if (looksLikeFile || existsOnDisk) {
      await createProgram().parseAsync([argv[0]!, argv[1]!, "run", ...argv.slice(2)]);
      return;
    }
  }

  await createProgram().parseAsync(argv);
}

async function main(): Promise<void> {
  await runCli(process.argv);
}

function isBootstrappedCliExecution(): boolean {
  return (globalThis as { __vexaCliBootstrappedEntry?: boolean }).__vexaCliBootstrappedEntry === true;
}

async function isDirectExecution(): Promise<boolean> {
  if (isBootstrappedCliExecution()) {
    return false;
  }
  if (process.argv[1] === undefined) return false;
  if (pathToFileURL(process.argv[1]).href === import.meta.url) return true;
  try {
    const { realpath } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const [resolvedArgv1, resolvedSelf] = await Promise.all([
      realpath(process.argv[1]),
      realpath(fileURLToPath(import.meta.url)),
    ]);
    return resolvedArgv1 === resolvedSelf;
  } catch {
    return false;
  }
}

const directExecutionKeepAlive = setTimeout(() => undefined, 1 << 30);
isDirectExecution()
  .then(async (directExecution) => {
    if (!directExecution) {
      return;
    }
    await main();
  })
  .catch((error) => {
    if (!(error instanceof DiagnosticError)) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(directExecutionKeepAlive);
    if ((process.exitCode ?? 0) !== 0) {
      process.exit(process.exitCode ?? 1);
    }
  });
