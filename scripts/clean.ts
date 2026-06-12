import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureGeneratedEmbedSupportFiles } from "../website/scripts/buildEmbed.ts";
import { ensureGeneratedSyntaxModule } from "../website/scripts/prepare.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");

const pathsToRemove = [
  resolve(projectRoot, "dist"),
  resolve(projectRoot, "plugins/monaco/dist"),
  resolve(projectRoot, "plugins/vscode/dist"),
  resolve(projectRoot, "website/_site"),
  resolve(projectRoot, "website/src/generated"),
  resolve(projectRoot, "website/src/assets/generated"),
];

async function cleanPath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

await Promise.all(pathsToRemove.map(cleanPath));

await Promise.all([
  mkdir(resolve(projectRoot, "website/_site/syntax"), { recursive: true }),
  mkdir(resolve(projectRoot, "website/src/assets/generated"), { recursive: true }),
  ensureGeneratedSyntaxModule(),
  ensureGeneratedEmbedSupportFiles(),
]);
