import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createPortableMonarchLanguage, MYLANG_PRIMITIVE_TYPES } from "../../compiler/syntax.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolve(scriptDirectory, "..");
const projectRoot = resolve(websiteRoot, "..");
const generatedSyntaxModulePath = resolve(websiteRoot, "src/generated/mylang-monarch-language.mjs");

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    child.on("error", rejectCommand);
    child.on("close", (code) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      rejectCommand(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function ensureCompilerBundle(): Promise<void> {
  const cliBundle = resolve(projectRoot, "dist/mylang.js");
  if (await pathExists(cliBundle)) {
    console.log("[website] Reusing existing compiler CLI bundle.");
    return;
  }
  console.log("[website] Compiler CLI bundle is missing; building it first.");
  await run("pnpm", ["build"], projectRoot);
}

function renderGeneratedSyntaxModule(): string {
  const portableLanguage = createPortableMonarchLanguage();
  return [
    `export const mylangPortableLanguage = ${JSON.stringify(portableLanguage, null, 2)};`,
    "",
    `export const mylangPrimitiveTypes = ${JSON.stringify([...MYLANG_PRIMITIVE_TYPES], null, 2)};`,
    "",
    "export default mylangPortableLanguage;",
    ""
  ].join("\n");
}

async function ensureGeneratedSyntaxModule(): Promise<void> {
  const nextContent = renderGeneratedSyntaxModule();
  const previousContent = await readFile(generatedSyntaxModulePath, "utf8").catch(() => null);
  if (previousContent === nextContent) {
    console.log("[website] Reusing generated website syntax module.");
    return;
  }

  await writeFile(generatedSyntaxModulePath, nextContent, "utf8");
  console.log("[website] Regenerated website syntax module.");
}

await ensureCompilerBundle();
await ensureGeneratedSyntaxModule();
await run("pnpm", ["exec", "vite", "build", "--config", "vite.config.ts"], websiteRoot);
await run("pnpm", ["exec", "eleventy", "--config", "eleventy.config.mjs"], websiteRoot);
