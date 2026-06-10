import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createPortableMonarchLanguage, VEXA_PRIMITIVE_TYPES } from "../../compiler/syntax.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const websiteRoot = resolve(scriptDirectory, "..");
const generatedSyntaxModulePath = resolve(websiteRoot, "src/generated/vexa-monarch-language.mjs");

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function run(command: string, args: string[], cwd: string): Promise<void> {
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

export function renderGeneratedSyntaxModule(): string {
  const portableLanguage = createPortableMonarchLanguage();
  return [
    `export const vexaPortableLanguage = ${JSON.stringify(portableLanguage, null, 2)};`,
    "",
    `export const vexaPrimitiveTypes = ${JSON.stringify([...VEXA_PRIMITIVE_TYPES], null, 2)};`,
    "",
    "export default vexaPortableLanguage;",
    ""
  ].join("\n");
}

export async function ensureGeneratedSyntaxModule(): Promise<void> {
  const nextContent = renderGeneratedSyntaxModule();
  const previousContent = await readFile(generatedSyntaxModulePath, "utf8").catch(() => null);
  if (previousContent === nextContent) {
    console.log("[website] Reusing generated website syntax module.");
    return;
  }

  await mkdir(dirname(generatedSyntaxModulePath), { recursive: true });
  await writeFile(generatedSyntaxModulePath, nextContent, "utf8");
  console.log("[website] Regenerated website syntax module.");
}
