import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { transpile } from "./runtime/transpile";
import { toAstPreview, tokenize } from "./runtime/tooling";

async function runLanguageServer(): Promise<void> {
  await import("./lsp/server");
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

function createProgram(): Command {
  const program = new Command()
    .name("mylang")
    .description("MyLang compiler CLI")
    .version("0.1.0");

  program
    .command("build")
    .description("Compile a MyLang file to JavaScript")
    .argument("<input>", "Input file")
    .option("-o, --out <file>", "Output file")
    .action(async (input: string, opts: { out?: string }) => {
      await buildFile(input, opts.out);
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

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  if (argv.includes("--language-server")) {
    await runLanguageServer();
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
