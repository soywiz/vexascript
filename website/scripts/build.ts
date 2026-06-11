import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureGeneratedSyntaxModule, pathExists, run } from "./prepare.ts";

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
  await rm(builtSitePath, { recursive: true, force: true });
  console.log("[website] Cleared previous Eleventy output.");
}

await ensureCompilerBundle();
await ensureGeneratedSyntaxModule();
await run("pnpm", ["exec", "vite", "build", "--config", "vite.config.ts"], websiteRoot);
await run("pnpm", ["exec", "vite", "build", "--config", "vite.playground.config.ts"], websiteRoot);
await cleanBuiltSite();
await run("pnpm", ["exec", "eleventy", "--config", "eleventy.config.mjs"], websiteRoot);
