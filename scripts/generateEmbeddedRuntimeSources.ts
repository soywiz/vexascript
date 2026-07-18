import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function templateLiteral(source: string): string {
  return `\`${source
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${")}\``;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const ecmaScript = await readFile(resolve(root, "compiler/runtime/es2025.d.ts"), "utf8");
  const vexaScript = await readFile(resolve(root, "compiler/runtime/vexascript.d.vx"), "utf8");
  const output = [
    "// Generated from compiler/runtime/es2025.d.ts and compiler/runtime/vexascript.d.vx.",
    "// Run `pnpm generate:runtime-sources` after changing either declaration source.",
    `export const ECMA_SCRIPT_RUNTIME_DECLARATIONS: string = ${templateLiteral(ecmaScript)};`,
    "",
    `export const VEXA_SCRIPT_RUNTIME_DECLARATIONS: string = ${templateLiteral(vexaScript)};`,
    ""
  ].join("\n");
  await writeFile(resolve(root, "compiler/runtime/embeddedRuntimeSources.ts"), output, "utf8");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
