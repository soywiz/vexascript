import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { transpile } from "./runtime/transpile";
import { format, toAstPreview, tokenize } from "./runtime/tooling";

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

async function buildFile(input: string, out?: string): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const source = await readFile(sourcePath, "utf8");
  const result = transpile(source);

  const outputPath = resolve(process.cwd(), out ?? input.replace(/\.[^.]+$/, ".js"));
  await writeFile(outputPath, result.code, "utf8");

  console.log(`Compiled: ${sourcePath} -> ${outputPath}`);
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`warning: ${warning}`);
    }
  }
}

async function runFile(input: string): Promise<void> {
  const sourcePath = resolve(process.cwd(), input);
  const source = await readFile(sourcePath, "utf8");
  const result = transpile(source);
  const jsToExecute = `${result.code}\n//# sourceURL=${sourcePath}`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(jsToExecute, "utf8").toString("base64")}`;
  await import(moduleUrl);

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`warning: ${warning}`);
    }
  }
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
    .action(async (input: string, opts: { out?: string }) => {
      await buildFile(input, opts.out);
    });

  program
    .command("run")
    .description("Transpile and run a MyLang file with Node.js")
    .argument("<input>", "Input file")
    .action(async (input: string) => {
      await runFile(input);
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
