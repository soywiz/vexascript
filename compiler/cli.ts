import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { transpile, type TranspileTarget } from "./runtime/transpile";
import { bundleModuleGraph } from "./runtime/moduleGraph";
import { format, toAstPreview, tokenize } from "./runtime/tooling";
import { loadProject } from "./project";
import { ensureDependencies } from "./deps";

async function runLanguageServer(): Promise<void> {
  await import("./lsp/server");
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
  const source = await readFile(sourcePath, "utf8");
  const outputPath = resolve(process.cwd(), out ?? input.replace(/\.[^.]+$/, ".js"));
  const result = transpile(source, {
    sourceFilePath: sourcePath,
    outputFilePath: outputPath,
    target,
    ...(jsxOptions.jsxFactory ? { jsxFactory: jsxOptions.jsxFactory } : {}),
    ...(jsxOptions.jsxFragmentFactory ? { jsxFragmentFactory: jsxOptions.jsxFragmentFactory } : {})
  });
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.error(`error: ${error}`);
    }
    throw new Error(`Compilation failed for ${sourcePath}`);
  }

  let outputCode = result.code;
  if (result.sourceMap) {
    const sourceMapPath = `${outputPath}.map`;
    const sourceMapFileName = basename(sourceMapPath);
    await writeFile(sourceMapPath, result.sourceMap, "utf8");
    outputCode = `${outputCode}\n//# sourceMappingURL=${sourceMapFileName}`;
  }
  await writeFile(outputPath, outputCode, "utf8");

  console.log(`Compiled: ${sourcePath} -> ${outputPath}`);
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`warning: ${warning}`);
    }
  }
}

export async function runFile(input: string, target: TranspileTarget = "conservative"): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const project = await loadProject(sourcePath);
  if (project && Object.keys(project.dependencies).length > 0) {
    await ensureDependencies(project.projectDir, project.dependencies);
  }
  // Bundle the entry file together with its local module graph so cross-file
  // references resolve, then execute the combined module.
  const result = bundleModuleGraph(sourcePath, target);
  await executeCompiled(result, sourcePath);
}

async function executeSource(source: string, sourcePath: string, target: TranspileTarget): Promise<void> {
  const outputPath = sourcePath.replace(/\.[^.]+$/, ".js");
  const result = transpile(source, {
    sourceFilePath: sourcePath,
    outputFilePath: outputPath,
    target,
    preserveSourceLineOffsets: true
  });
  await executeCompiled(result, sourcePath);
}

async function executeCompiled(
  result: { code: string; warnings: string[]; errors: string[]; sourceMap?: string },
  sourcePath: string
): Promise<void> {
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.error(`error: ${error}`);
    }
    throw new Error(`Compilation failed for ${sourcePath}`);
  }
  const inlineSourceMap = result.sourceMap
    ? `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(result.sourceMap, "utf8").toString("base64")}`
    : "";
  const jsToExecute = `${result.code}${inlineSourceMap}\n//# sourceURL=${sourcePath}`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(jsToExecute, "utf8").toString("base64")}`;
  await import(moduleUrl);

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`warning: ${warning}`);
    }
  }
}

const TEST_RUNTIME_SOURCE = `@JsInline("((function test() { call() })())")
fun test(call: any)
@JsInline("if (!cond) throw new Error(message)")
fun assert(cond: boolean, message: string = "assert failed")
`;

const IGNORED_TEST_DIRECTORIES = new Set([".git", "dist", "node_modules"]);

async function discoverTestFiles(path: string): Promise<string[]> {
  const resolvedPath = resolve(process.cwd(), path);
  const info = await stat(resolvedPath);
  if (info.isFile()) {
    return resolvedPath.endsWith(".test.my") ? [resolvedPath] : [];
  }
  if (!info.isDirectory()) {
    return [];
  }

  const entries = await readdir(resolvedPath, { withFileTypes: true });
  const discovered: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && IGNORED_TEST_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const entryPath = resolve(resolvedPath, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...await discoverTestFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.my")) {
      discovered.push(entryPath);
    }
  }
  return discovered;
}

async function runTests(paths: string[]): Promise<void> {
  const discovered = await Promise.all((paths.length > 0 ? paths : [process.cwd()]).map(discoverTestFiles));
  const testFiles = [...new Set(discovered.flat())].sort();
  if (testFiles.length === 0) {
    throw new Error("No .test.my files found");
  }

  for (const testFile of testFiles) {
    const source = await readFile(testFile, "utf8");
    await executeSource(`${source}\n${TEST_RUNTIME_SOURCE}`, testFile, "conservative");
    console.log(`Passed: ${testFile}`);
  }
  console.log(`${testFiles.length} test file${testFiles.length === 1 ? "" : "s"} passed`);
}

async function printTokens(input: string): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const source = await readFile(sourcePath, "utf8");
  console.log(JSON.stringify(tokenize(source), null, 2));
}

async function printAst(input: string): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const source = await readFile(sourcePath, "utf8");
  console.log(JSON.stringify(toAstPreview(source), null, 2));
}

async function formatFile(input: string, opts: { write?: boolean; out?: string }): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const source = await readFile(sourcePath, "utf8");
  const formatted = format(source);
  const formattedWithTrailingNewline = `${formatted}\n`;

  await writeFile(sourcePath, formattedWithTrailingNewline, "utf8");
  if (opts.out) {
    const outputPath = resolve(process.cwd(), opts.out);
    await writeFile(outputPath, formattedWithTrailingNewline, "utf8");
    console.log(`Formatted: ${sourcePath} (and wrote copy to ${outputPath})`);
    return;
  }

  console.log(`Formatted: ${sourcePath}`);
}

function createProgram(): Command {
  const program = new Command()
    .name("mylang")
    .description("MyLang compiler CLI")
    .version("0.1.0");

  program
    .option("--lsp", "Start the language server over stdio")
    .option("--language-server", "Start the language server over stdio (alias of --lsp)");

  program
    .command("build")
    .description("Compile a MyLang file to JavaScript")
    .argument("<input>", "Input file")
    .option("-o, --out <file>", "Output file")
    .option("--target <mode>", "Transpile target mode: conservative|optimized", "optimized")
    .option("--jsx-factory <factory>", "Callee used for embedded XML/JSX elements (default: React.createElement)")
    .option("--jsx-fragment-factory <factory>", "Expression used for JSX fragments (default: React.Fragment)")
    .action(async (input: string, opts: { out?: string; target?: string; jsxFactory?: string; jsxFragmentFactory?: string }) => {
      const target = opts.target === "conservative" ? "conservative" : "optimized";
      await buildFile(input, opts.out, target, {
        ...(opts.jsxFactory ? { jsxFactory: opts.jsxFactory } : {}),
        ...(opts.jsxFragmentFactory ? { jsxFragmentFactory: opts.jsxFragmentFactory } : {})
      });
    });

  program
    .command("run")
    .description("Transpile and run a MyLang file with Node.js")
    .argument("<input>", "Input file")
    .option("--target <mode>", "Transpile target mode: conservative|optimized", "conservative")
    .action(async (input: string, opts: { target?: string }) => {
      const target = opts.target === "conservative" ? "conservative" : "optimized";
      await runFile(input, target);
    });

  program
    .command("test")
    .description("Discover and run .test.my files with inline test and assert helpers")
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
    .description("Format a MyLang file")
    .argument("<input>", "Input file")
    .option("-w, --write", "Deprecated: formatting now always overwrites the input file")
    .option("-o, --out <file>", "Output file")
    .action(async (input: string, opts: { write?: boolean; out?: string }) => {
      await formatFile(input, opts);
    });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
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

  await createProgram().parseAsync(argv);
}

async function main(): Promise<void> {
  await runCli(process.argv);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
