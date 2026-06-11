import { rm } from "node:fs/promises";
import { ensureGeneratedSyntaxModule, pathExists, run } from "./prepare.ts";
import { dirname, fileURLToPath, resolve } from "compiler/utils/path.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolve(scriptDirectory, "..");
const projectRoot = resolve(websiteRoot, "..");
const builtSitePath = resolve(websiteRoot, "_site");

async function ensureCompilerBundle(): Promise<void> {
  const cliBundle = resolve(projectRoot, "dist/vexa.js");
  if (await pathExists(cliBundle)) {
    console.log("[website] Reusing existing compiler CLI bundle.");
    return;
  }
  console.log("[website] Compiler CLI bundle is missing; building it first.");
  await run("pnpm", ["build"], projectRoot);
}

async function cleanBuiltSite(): Promise<void> {
  await rm(builtSitePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  console.log("[website] Cleared previous Eleventy output.");
}

await ensureCompilerBundle();
await ensureGeneratedSyntaxModule();
await run("pnpm", ["exec", "tsx", "scripts/buildEmbed.ts"], websiteRoot);
await cleanBuiltSite();
await run("pnpm", ["exec", "eleventy", "--config", "eleventy.config.mjs"], websiteRoot);
