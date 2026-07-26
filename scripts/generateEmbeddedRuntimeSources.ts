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
  const dom = await readFile(resolve(root, "compiler/runtime/dom.d.ts"), "utf8");
  const vexaScript = await readFile(resolve(root, "compiler/runtime/vexascript.d.vx"), "utf8");
  const output = [
    "// Generated from compiler/runtime/es2025.d.ts and compiler/runtime/vexascript.d.vx.",
    "// Run `pnpm generate:runtime-sources` after changing either declaration source.",
    `export const ECMA_SCRIPT_RUNTIME_DECLARATIONS: string = ${templateLiteral(ecmaScript)};`,
    "",
    `export const VEXA_SCRIPT_RUNTIME_DECLARATIONS: string = ${templateLiteral(vexaScript)};`,
    ""
  ].join("\n");
  const domOutput = [
    "// Generated from compiler/runtime/dom.d.ts.",
    "// Run `pnpm generate:runtime-sources` after changing the declaration source.",
    `export const DOM_RUNTIME_DECLARATIONS: string = ${templateLiteral(dom)};`,
    ""
  ].join("\n");
  await Promise.all([
    writeFile(resolve(root, "compiler/runtime/embeddedRuntimeSources.ts"), output, "utf8"),
    writeFile(resolve(root, "compiler/runtime/embeddedDomSource.ts"), domOutput, "utf8")
  ]);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
