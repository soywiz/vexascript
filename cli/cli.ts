import "./localVfs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { Command } from "./command";
import { transpile, type TranspileDiagnostic, type TranspileTarget } from "../compiler/runtime/transpile";
import { LANGUAGE_CLI_BIN, LANGUAGE_FILE_EXTENSION, replaceLanguageExtension } from "../compiler/language";
import { loadProject } from "../compiler/project";
import { SYNTAX_TARGETS, type SyntaxTarget } from "../compiler/syntaxTargets";
import { COMPILER_VERSION } from "../compiler/compilerVersion";
import { basename, dirname, extname, resolve } from "../compiler/utils/path";
import { vfs } from "../compiler/vfs";
import { monotonicNow, roundedMilliseconds } from "../compiler/utils/time";
import {
  ambientDeclarationsForProject,
  createBundledModuleArtifacts,
  ensureRuntimeDependencies,
  globalDeclarationsForProject,
  resolveServeBundleInput,
  usesExternalTypeScriptCheck,
  vexaTypeCheckForSource
} from "./cliShared";
import {
  astForCli,
  executeJavaScriptModule,
  formatForCli,
  isBootstrappedCliExecution,
  isDirectModuleExecution,
  openUrlInDefaultBrowser,
  renderSyntaxForCli,
  resolveNodeModuleImportsForCli,
  runCommand as runProcessCommand,
  runAsyncMain,
  runTestFiles,
  runtimePid,
  startLanguageServer,
  startMcpServer,
  startServe,
  testRuntimeImportsForCli,
  tokenizeForCli,
} from "./io";

/** Thrown when diagnostics have already been printed; the top-level handler should exit silently. */
export class DiagnosticError extends Error {
  constructor() { super("Compilation failed"); this.name = "DiagnosticError"; }
}

class JsxOptions {
  constructor(public jsxFactory: string = "", public jsxFragmentFactory: string = "") {}
}

class BuildOptions {
  constructor(public target: TranspileTarget, public jsxOptions: JsxOptions) {}
}

class CopyDirectoryOptions {
  constructor(public bundleFileName?: string) {}
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

function printDiagnostics(errors: string[], diagnostics: TranspileDiagnostic[] | undefined, file: string): void {
  const useColor = false;
  if (diagnostics && diagnostics.length > 0) {
    for (const diag of diagnostics) {
      printDiagnostic(diag, useColor);
    }
  } else {
    for (const error of errors) {
      console.error(`${file}: error: ${error}`);
    }
  }
}

function formatPhaseTimings(phaseTimings: Map<string, number>): string {
  const timingParts: string[] = [];
  for (const [phase, elapsedMs] of phaseTimings) {
    timingParts.push(`${phase} ${roundedMilliseconds(elapsedMs)}ms`);
  }
  return timingParts.join(", ");
}

async function runLanguageServer(): Promise<void> {
  await startLanguageServer();
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
  jsxOptions: JsxOptions = new JsxOptions(),
  typeCheck = true
): Promise<void> {
  const buildStartedAt = monotonicNow();
  const phaseTimings = new Map<string, number>();
  const sourcePath = resolve(process.cwd(), input);
  const sourceLoadStartedAt = monotonicNow();
  const source = (await vfs().readFile(sourcePath))!;
  phaseTimings.set("source-load", monotonicNow() - sourceLoadStartedAt);
  const projectLoadStartedAt = monotonicNow();
  const project = await loadProject(sourcePath);
  phaseTimings.set("project-load", monotonicNow() - projectLoadStartedAt);
  const typeCheckStartedAt = monotonicNow();
  let typeCheckElapsedMs = 0;
  const semanticValidation = (async (): Promise<boolean> => {
    try {
      return await vexaTypeCheckForSource(sourcePath, project, typeCheck);
    } finally {
      typeCheckElapsedMs = monotonicNow() - typeCheckStartedAt;
    }
  })();
  const vexaTypeCheck = usesExternalTypeScriptCheck(sourcePath, typeCheck)
    ? false
    : await semanticValidation;
  const outputPath = resolve(process.cwd(), out ?? replaceLanguageExtension(input, ".js"));
  const declarationsStartedAt = monotonicNow();
  const ambientDeclarations = await ambientDeclarationsForProject(sourcePath, project);
  const globalDeclarations = await globalDeclarationsForProject(project);
  phaseTimings.set("declarations", monotonicNow() - declarationsStartedAt);
  const result = transpile(source, {
    sourceFilePath: sourcePath,
    outputFilePath: outputPath,
    target,
    typeCheck: vexaTypeCheck,
    emitSourceMap: true,
    ambientDeclarations: [...ambientDeclarations, ...globalDeclarations],
    rewriteImportExtensions: true,
    profile: (event) => phaseTimings.set(event.phase, event.elapsedMs),
    ...(project?.jsxFactory ? { jsxFactory: project.jsxFactory } : {}),
    ...(project?.jsxFragmentFactory ? { jsxFragmentFactory: project.jsxFragmentFactory } : {}),
    ...(jsxOptions.jsxFactory ? { jsxFactory: jsxOptions.jsxFactory } : {}),
    ...(jsxOptions.jsxFragmentFactory ? { jsxFragmentFactory: jsxOptions.jsxFragmentFactory } : {})
  });
  await semanticValidation;
  if (result.errors.length > 0) {
    printDiagnostics(result.errors, result.diagnostics, sourcePath);
    throw new Error(`Compilation failed for ${sourcePath}`);
  }

  const writeStartedAt = monotonicNow();
  let outputCode = result.code;
  if (result.sourceMap) {
    const sourceMapPath = `${outputPath}.map`;
    const sourceMapFileName = basename(sourceMapPath);
    await vfs().writeFile(sourceMapPath, result.sourceMap);
    outputCode = `${outputCode}\n//# sourceMappingURL=${sourceMapFileName}`;
  }
  await vfs().writeFile(outputPath, outputCode);
  phaseTimings.set("write", monotonicNow() - writeStartedAt);
  phaseTimings.set("total", monotonicNow() - buildStartedAt);

  console.log(
    `Compiled: ${sourcePath} -> ${outputPath} ` +
    `(${formatPhaseTimings(new Map([
      ["source-load", phaseTimings.get("source-load") ?? 0],
      ["project-load", phaseTimings.get("project-load") ?? 0],
      ["declarations", phaseTimings.get("declarations") ?? 0],
      ["type-check", typeCheckElapsedMs],
      ["parse", phaseTimings.get("parse") ?? 0],
      ["analysis", phaseTimings.get("analysis") ?? 0],
      ["emit", phaseTimings.get("emit") ?? 0],
      ["write", phaseTimings.get("write") ?? 0],
      ["total", phaseTimings.get("total") ?? 0],
    ]))})`
  );
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
  jsxOptions: JsxOptions = new JsxOptions(),
  typeCheck = true,
  platform: "browser" | "node" = "browser"
): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const project = await loadProject(sourcePath);
  await ensureRuntimeDependencies(sourcePath, project);

  const outputPath = resolve(process.cwd(), out ?? replaceLanguageExtension(input, ".js"));
  const result = await createBundledModuleArtifacts(sourcePath, target, project, jsxOptions, {
    typeCheck,
    externalDependencyStrategy: platform === "node" ? "node-require" : "runtime-error"
  });
  if (result.errors.length > 0) {
    printDiagnostics(result.errors, result.diagnostics, sourcePath);
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

function buildOutputFileName(bundleInput: string): string {
  return replaceLanguageExtension(basename(bundleInput), ".js");
}

function replaceBuildEntrypoint(html: string, bundleFileName: string): string {
  return html.split("%VEXA_ENTRYPOINT%").join(bundleFileName);
}

function isWithinDirectory(rootDir: string, targetPath: string): boolean {
  return targetPath === rootDir || targetPath.startsWith(`${rootDir}/`);
}

function shouldSkipRootEntry(outputDir: string, entryPath: string): boolean {
  if (entryPath === outputDir || entryPath.startsWith(`${outputDir}/`)) {
    return true;
  }
  const name = basename(entryPath);
  if (name === "node_modules" || name === ".git" || name === "vexascript.json" || name === "tsconfig.json") {
    return true;
  }
  const extension = extname(entryPath).toLowerCase();
  return extension === LANGUAGE_FILE_EXTENSION || extension === ".ts" || extension === ".tsx";
}

async function copyBuildRootStaticFiles(
  sourceDir: string,
  outputDir: string,
  bundleFileName: string
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry.name);
    if (shouldSkipRootEntry(outputDir, sourcePath)) {
      continue;
    }
    const targetPath = resolve(outputDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath, new CopyDirectoryOptions(bundleFileName));
      continue;
    }
    await copyBuildFile(sourcePath, targetPath, bundleFileName);
  }
}

async function copyDirectoryContents(
  sourceDir: string,
  targetDir: string,
  options: CopyDirectoryOptions
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry.name);
    const targetPath = resolve(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath, options);
      continue;
    }
    await copyBuildFile(sourcePath, targetPath, options.bundleFileName);
  }
}

async function copyBuildFile(sourcePath: string, targetPath: string, bundleFileName?: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  if (extname(sourcePath).toLowerCase() === ".html") {
    const html = await readFile(sourcePath, "utf8");
    await writeFile(targetPath, replaceBuildEntrypoint(html, bundleFileName ?? "bundle.js"), "utf8");
    return;
  }
  await copyFile(sourcePath, targetPath);
}

async function copyServeMappingsToBuildOutput(
  outputDir: string,
  mappings: readonly { from: string; to: string }[],
  bundleFileName: string
): Promise<void> {
  for (const mapping of mappings) {
    const sourceInfo = await stat(mapping.from).catch((_error) => null);
    if (!sourceInfo) {
      continue;
    }
    const targetPath = resolve(outputDir, mapping.to);
    if (!isWithinDirectory(outputDir, targetPath)) {
      throw new Error(`Mapped output path escapes build directory: ${mapping.to}`);
    }
    if (sourceInfo.isDirectory()) {
      await copyDirectoryContents(mapping.from, targetPath, new CopyDirectoryOptions(bundleFileName));
      continue;
    }
    await copyBuildFile(mapping.from, targetPath, bundleFileName);
  }
}

async function buildDirectory(
  input: string,
  out?: string,
  target: TranspileTarget = "optimized",
  jsxOptions: JsxOptions = new JsxOptions()
): Promise<void> {
  const rootDir = resolve(process.cwd(), input);
  const project = await loadProject(rootDir);
  const bundleInput = project?.bundleEntrypoint;
  if (!bundleInput) {
    throw new Error(`No bundle entrypoint provided. Add "entrypoint" to ${rootDir}/vexascript.json`);
  }
  await ensureRuntimeDependencies(bundleInput, project);
  const outputDir = resolve(process.cwd(), out ?? project?.buildOutputDir ?? resolve(rootDir, "dist"));
  if (outputDir === rootDir) {
    throw new Error(`Build output directory must not be the project root: ${outputDir}`);
  }

  const bundleFileName = buildOutputFileName(bundleInput);
  const bundleOutputPath = resolve(outputDir, bundleFileName);
  const result = await createBundledModuleArtifacts(bundleInput, target, project, jsxOptions);
  if (result.errors.length > 0) {
    printDiagnostics(result.errors, result.diagnostics, bundleInput);
    throw new Error(`Compilation failed for ${bundleInput}`);
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await copyBuildRootStaticFiles(rootDir, outputDir, bundleFileName);
  await copyServeMappingsToBuildOutput(outputDir, project?.serveMappings ?? [], bundleFileName);
  await vfs().writeFile(bundleOutputPath, result.code);

  console.log(`Built: ${rootDir} -> ${outputDir}`);
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`warning: ${warning}`);
    }
  }
}

type RunRuntime = "node" | "deno";

export async function runFile(
  input: string,
  target: TranspileTarget = "conservative",
  runtime: RunRuntime = "node"
): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const project = await loadProject(sourcePath);
  await ensureRuntimeDependencies(sourcePath, project);
  const result = await createBundledModuleArtifacts(sourcePath, target, project, new JsxOptions(), {
    externalDependencyStrategy: runtime === "node" ? "node-require" : "runtime-error"
  });
  await executeCompiled(result.code, result.warnings, result.errors, undefined, result.diagnostics, sourcePath, runtime);
}

async function transpileSource(
  source: string,
  sourcePath: string,
  target: TranspileTarget,
  outputPath = replaceLanguageExtension(sourcePath, ".js")
): Promise<ReturnType<typeof transpile>> {
  const project = await loadProject(sourcePath);
  const ambientDeclarations = await ambientDeclarationsForProject(sourcePath, project);
  const globalDeclarations = await globalDeclarationsForProject(project);
  const imported = await resolveNodeModuleImportsForCli(source, sourcePath);
  return transpile(source, {
    sourceFilePath: sourcePath,
    outputFilePath: outputPath,
    target,
    preserveSourceLineOffsets: true,
    ambientDeclarations: [...ambientDeclarations, ...globalDeclarations],
    externalDeclarations: imported.externalDeclarations,
    importedSymbols: imported.importedSymbols,
    ...(project?.jsxFactory ? { jsxFactory: project.jsxFactory } : {}),
    ...(project?.jsxFragmentFactory ? { jsxFragmentFactory: project.jsxFragmentFactory } : {})
  });
}

async function executeCompiled(
  code: string,
  warnings: string[],
  errors: string[],
  sourceMap: string | undefined,
  diagnostics: TranspileDiagnostic[] | undefined,
  sourcePath: string,
  runtime: RunRuntime = "node"
): Promise<void> {
  if (errors.length > 0) {
    printDiagnostics(errors, diagnostics, sourcePath);
    throw new DiagnosticError();
  }
  if (runtime === "node") {
    await executeJavaScriptModule(code, sourceMap, sourcePath);
  } else {
    const outputPath = `${sourcePath}.vexa-run-${runtimePid()}-${Date.now()}.mjs`;
    try {
      await vfs().writeFile(outputPath, `${code}\n//# sourceURL=${sourcePath}`);
      await runProcessCommand("deno", ["run", "-A", outputPath]);
    } finally {
      try {
        await vfs().unlink(outputPath);
      } catch {
        // The temporary output is best-effort cleanup after the runtime exits.
      }
    }
  }

  if (warnings.length > 0) {
    for (const warning of warnings) {
      console.warn(`warning: ${warning}`);
    }
  }
}

async function compileTestSource(source: string, testFile: string, outputFile: string): Promise<void> {
  const result = await transpileSource(source, testFile, "conservative", outputFile);
  if (result.errors.length > 0) {
    printDiagnostics(result.errors, result.diagnostics, testFile);
    throw new DiagnosticError();
  }
  const nodeTestImports = await testRuntimeImportsForCli(source);
  await vfs().writeFile(
    outputFile,
    `${nodeTestImports}${nodeTestImports.length > 0 ? "\n" : ""}${result.code}\n//# sourceURL=${testFile}`
  );
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
}

async function runTests(paths: string[], nodeArgs: string[]): Promise<void> {
  const testFiles = await runTestFiles(paths, nodeArgs, compileTestSource);
  console.log(`${testFiles.length} test file${testFiles.length === 1 ? "" : "s"} passed`);
}

const NODE_TEST_FLAGS_WITH_VALUES = new Set([
  "--test-concurrency",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-skip-pattern",
  "--test-timeout"
]);

function splitTestArguments(args: string[]): { paths: string[]; nodeArgs: string[] } {
  const paths: string[] = [];
  const nodeArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    nodeArgs.push(arg);
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (NODE_TEST_FLAGS_WITH_VALUES.has(flag) && !arg.includes("=") && args[index + 1] !== undefined) {
      nodeArgs.push(args[++index]!);
    } else if (!arg.startsWith("-")) {
      nodeArgs.pop();
      paths.push(arg);
    }
  }
  return { paths, nodeArgs };
}

async function printTokens(input: string): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const source = await vfs().readFile(sourcePath);
  console.log(JSON.stringify(await tokenizeForCli(source), null, 2));
}

async function printAst(input: string): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const source = await vfs().readFile(sourcePath);
  console.log(JSON.stringify(await astForCli(source), null, 2));
}

async function formatFile(input: string, opts: { write?: boolean; out?: string }): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const source = await vfs().readFile(sourcePath);
  const formatted = await formatForCli(source);
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
    opts.monaco === true ? "monaco" : undefined,
    opts.monacoLanguage === true ? "monaco-language" : undefined,
    opts.monacoConfiguration === true ? "monaco-configuration" : undefined,
    opts.vscode === true ? "vscode-grammar" : undefined,
    opts.vscodeGrammar === true ? "vscode-grammar" : undefined,
    opts.vscodeConfiguration === true ? "vscode-configuration" : undefined,
    opts.codemirror === true ? "codemirror-legacy" : undefined,
    opts.textmate === true ? "textmate" : undefined,
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
  console.log(await renderSyntaxForCli(resolveSyntaxTarget(opts)));
}

function expandPackedRunArgument(argv: string[]): string[] {
  const packedCommand = argv[2];
  if (!packedCommand || !packedCommand.includes(" ")) {
    return argv;
  }
  const commandParts = packedCommand.trim().split(/\s+/);
  if (commandParts[0] !== "run") {
    return argv;
  }
  return [argv[0]!, argv[1]!, ...commandParts, ...argv.slice(3)];
}

function createProgram(): Command {
  const program = new Command();
  program.name(LANGUAGE_CLI_BIN);
  program.description(`VexaScript compiler CLI - ${COMPILER_VERSION} - Soywiz Software 2026`);
  program.version(COMPILER_VERSION);

  const lspCommand = program.command("lsp");
  lspCommand.description("Start the language server");
  lspCommand.allowUnknownOption(true);
  lspCommand.action0(async (): Promise<void> => {
      const lspArgv = ensureLspTransportArg(process.argv);
      const originalArgv = process.argv;
      process.argv = lspArgv;
      try {
        await runLanguageServer();
      } finally {
        process.argv = originalArgv;
      }
  });

  const mcpCommand = program.command("mcp");
  mcpCommand.description("Start the VexaScript MCP codebase navigation server");
  mcpCommand.option("--root <dir>", "Workspace root used to resolve relative file paths and scan symbols", process.cwd());
  mcpCommand.actionOptions(async (opts: { root?: string }): Promise<void> => {
    await startMcpServer({ cwd: resolve(process.cwd(), opts.root ?? ".") });
  });

  const syntaxCommand = program.command("syntax");
  syntaxCommand.description("Print embedded VexaScript syntax definitions for editor integrations");
  syntaxCommand.option("--target <name>", `Syntax target: ${SYNTAX_TARGETS.join("|")}`);
  syntaxCommand.option("--monaco", "Print Monaco-ready bundle source");
  syntaxCommand.option("--monaco-language", "Print Monaco Monarch language JSON");
  syntaxCommand.option("--monaco-configuration", "Print Monaco language-configuration JSON");
  syntaxCommand.option("--vscode", "Print VS Code/TextMate grammar JSON");
  syntaxCommand.option("--vscode-grammar", "Print VS Code/TextMate grammar JSON");
  syntaxCommand.option("--vscode-configuration", "Print VS Code language-configuration JSON");
  syntaxCommand.option("--codemirror", "Print CodeMirror legacy mode source");
  syntaxCommand.option("--textmate", "Print TextMate grammar JSON");
  syntaxCommand.actionOptions(async (opts: {
      target?: string;
      monaco?: boolean;
      monacoLanguage?: boolean;
      monacoConfiguration?: boolean;
      vscode?: boolean;
      vscodeGrammar?: boolean;
      vscodeConfiguration?: boolean;
      codemirror?: boolean;
      textmate?: boolean;
  }): Promise<void> => {
    await printSyntax(opts);
  });

  const resolveBuildOptions = (opts: { target?: string; jsxFactory?: string; jsxFragmentFactory?: string }): BuildOptions =>
    new BuildOptions(
      opts.target === "conservative" ? "conservative" : "optimized",
      new JsxOptions(opts.jsxFactory ?? "", opts.jsxFragmentFactory ?? "")
    );
  const buildCommand = program.command("build");
  buildCommand.description("Compile a VexaScript file to JavaScript");
  buildCommand.argument("<input>", "Input file or project directory");
  buildCommand.option("-o, --out <path>", "Output file for file builds, or output directory for project builds");
  buildCommand.option("--target <mode>", "Transpile target mode: conservative|optimized", "optimized");
  buildCommand.option("--jsx-factory <factory>", "Callee used for embedded XML/JSX elements (default: React.createElement)");
  buildCommand.option("--jsx-fragment-factory <factory>", "Expression used for JSX fragments (default: React.Fragment)");
  buildCommand.option("--bundle", "Bundle the entry and all referenced VexaScript, TypeScript, JavaScript, and node_modules packages as ESM");
  buildCommand.option("--transpile-only", "Emit TypeScript without failing on VexaScript semantic diagnostics");
  buildCommand.option("--platform <platform>", "Bundle platform: browser|node", "browser");
  buildCommand.actionInput(async (input: string, opts: { out?: string; target?: string; jsxFactory?: string; jsxFragmentFactory?: string; bundle?: boolean; transpileOnly?: boolean; platform?: string }): Promise<void> => {
      const buildOptions = resolveBuildOptions(opts);
      const target = buildOptions.target;
      const jsxOptions = buildOptions.jsxOptions;
      const inputPath = resolve(process.cwd(), input);
      const inputStats = await vfs().stat(inputPath).catch((_error) => null);
      if (inputStats?.isDirectory) {
        await buildDirectory(input, opts.out, target, jsxOptions);
        return;
      }
      if (opts.bundle === true) {
        if (opts.platform !== "browser" && opts.platform !== "node") {
          throw new Error(`Unsupported bundle platform "${opts.platform}". Supported platforms: browser, node`);
        }
        await bundleFile(input, opts.out, target, jsxOptions, opts.transpileOnly !== true, opts.platform);
        return;
      }
      await buildFile(input, opts.out, target, jsxOptions, opts.transpileOnly !== true);
  });


  const bundleCommand = program.command("bundle");
  bundleCommand.description("Bundle a VexaScript entry file, or build a configured project directory");
  bundleCommand.argument("<input>", "Input file or project directory");
  bundleCommand.option("-o, --out <path>", "Output file for file builds, or output directory for project builds");
  bundleCommand.option("--target <mode>", "Transpile target mode: conservative|optimized", "optimized");
  bundleCommand.option("--jsx-factory <factory>", "Callee used for embedded XML/JSX elements (default: React.createElement)");
  bundleCommand.option("--jsx-fragment-factory <factory>", "Expression used for JSX fragments (default: React.Fragment)");
  bundleCommand.option("--transpile-only", "Emit TypeScript without failing on VexaScript semantic diagnostics");
  bundleCommand.option("--platform <platform>", "Bundle platform: browser|node", "browser");
  bundleCommand.actionInput(async (input: string, opts: { out?: string; target?: string; jsxFactory?: string; jsxFragmentFactory?: string; transpileOnly?: boolean; platform?: string }): Promise<void> => {
      const buildOptions = resolveBuildOptions(opts);
      const target = buildOptions.target;
      const jsxOptions = buildOptions.jsxOptions;
      const inputPath = resolve(process.cwd(), input);
      const inputStats = await vfs().stat(inputPath).catch((_error) => null);
      if (inputStats?.isDirectory) {
        await buildDirectory(input, opts.out, target, jsxOptions);
        return;
      }
      if (opts.platform !== "browser" && opts.platform !== "node") {
        throw new Error(`Unsupported bundle platform "${opts.platform}". Supported platforms: browser, node`);
      }
      await bundleFile(input, opts.out, target, jsxOptions, opts.transpileOnly !== true, opts.platform);
  });

  const serveCommand = program.command("serve");
  serveCommand.description("Serve a static folder, inject the bundle into HTML, and live-reload on bundle changes");
  serveCommand.argument("[dir]", "Folder to serve", ".");
  serveCommand.option("--bundle <input>", "Bundle entry VexaScript file");
  serveCommand.option("--open", "Open the served site in the default browser");
  serveCommand.option("--port <number>", "HTTP port", "8080");
  serveCommand.option("--target <mode>", "Transpile target mode: conservative|optimized", "optimized");
  serveCommand.option("--jsx-factory <factory>", "Callee used for embedded XML/JSX elements (default: React.createElement)");
  serveCommand.option("--jsx-fragment-factory <factory>", "Expression used for JSX fragments (default: React.Fragment)");
  serveCommand.actionInput(async (
      dir: string,
      opts: { bundle?: string; open?: boolean; port?: string; target?: string; jsxFactory?: string; jsxFragmentFactory?: string }
    ): Promise<void> => {
      const buildOptions = resolveBuildOptions(opts);
      const target = buildOptions.target;
      const jsxOptions = buildOptions.jsxOptions;
      const rootDir = dir;
      const bundleInput = await resolveServeBundleInput(rootDir, opts.bundle);
      const portNumber = parseInt(opts.port ?? "8080", 10);
      const port = await startServe({
        rootDir,
        bundleInput,
        port: portNumber,
        target,
        ...jsxOptions,
        onDiagnosticError: (result: { errors: string[]; diagnostics?: TranspileDiagnostic[] }, file: string) =>
          printDiagnostics(result.errors, result.diagnostics, file)
      });
      if (opts.open === true) {
        const url = `http://localhost:${port}`;
        try {
          await openUrlInDefaultBrowser(url);
        } catch (error) {
          const message = String(error);
          console.warn(`Unable to open ${url} in the default browser: ${message}`);
        }
      }
  });

  const runCommand = program.command("run");
  runCommand.description("Transpile and run a VexaScript file with Node.js or Deno");
  runCommand.argument("<input>", "Input file");
  runCommand.option("--target <mode>", "Transpile target mode: conservative|optimized", "conservative");
  runCommand.option("-deno, --deno", "Run with Deno and grant all permissions (-A)");
  runCommand.actionInput(async (input: string, opts: { target?: string; deno?: boolean }): Promise<void> => {
    const target = opts.target === "conservative" ? "conservative" : "optimized";
    await runFile(input, target, opts.deno === true ? "deno" : "node");
  });

  const testCommand = program.command("test");
  testCommand.description(`Discover and run .test${LANGUAGE_FILE_EXTENSION} files with Node's test runner`);
  testCommand.allowUnknownOption(true);
  testCommand.argument("[paths...]", "Test files or directories", []);
  testCommand.actionStrings(async (args: string[]): Promise<void> => {
    const testArguments = splitTestArguments(args);
    await runTests(testArguments.paths, testArguments.nodeArgs);
  });

  const tokensCommand = program.command("tokens");
  tokensCommand.description("Show file tokens");
  tokensCommand.argument("<input>", "Input file");
  tokensCommand.actionString(async (input: string): Promise<void> => {
    await printTokens(input);
  });

  const astCommand = program.command("ast");
  astCommand.description("Show simplified AST");
  astCommand.argument("<input>", "Input file");
  astCommand.actionString(async (input: string): Promise<void> => {
    await printAst(input);
  });

  const formatCommand = program.command("format");
  formatCommand.description("Format a VexaScript file");
  formatCommand.argument("<input>", "Input file");
  formatCommand.option("-w, --write", "Deprecated: formatting now always overwrites the input file");
  formatCommand.option("-o, --out <file>", "Output file");
  formatCommand.actionInput(async (input: string, opts: { write?: boolean; out?: string }): Promise<void> => {
    await formatFile(input, opts);
  });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const expandedArgv = expandPackedRunArgument(argv);
  if (expandedArgv !== argv) {
    await runCli(expandedArgv);
    return;
  }

  if (argv[2] === LANGUAGE_CLI_BIN) {
    await runCli([argv[0]!, argv[1]!, ...argv.slice(3)]);
    return;
  }

  if (argv.length <= 2) {
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

  const knownCommands = new Set(["build", "cpp", "bundle", "serve", "run", "test", "tokens", "ast", "format", "syntax", "lsp", "mcp"]);
  const firstArg = argv[2];
  if (firstArg !== undefined && !firstArg.startsWith("-") && !knownCommands.has(firstArg)) {
    const looksLikeFile = firstArg.includes("/") || firstArg.includes(".");
    const existsOnDisk = await vfs().stat(resolve(process.cwd(), firstArg)).then((_stat) => true).catch((_error) => false);
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

async function isDirectExecution(): Promise<boolean> {
  if (isBootstrappedCliExecution()) {
    return false;
  }
  return await isDirectModuleExecution();
}

async function runDirectExecution(): Promise<void> {
  try {
    if (await isDirectExecution()) {
      await main();
    }
  } catch (error) {
    if (!(error instanceof DiagnosticError)) {
      const errorValue: any = error;
      const message: string = String(errorValue?.message ?? errorValue);
      console.error(message);
    }
    process.exit(1 as number);
  }
  const exitCode: number = typeof process.exitCode === "number" ? process.exitCode : 0;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

runAsyncMain(runDirectExecution());
