import { ensureGeneratedSyntaxModule, run, websiteRoot } from "./prepare.ts";

await ensureGeneratedSyntaxModule();
await run("pnpm", ["exec", "tsx", "scripts/buildEmbed.ts", "--mode=development"], websiteRoot);
await Promise.all([
  run("pnpm", ["exec", "tsx", "scripts/buildEmbed.ts", "--watch", "--mode=development"], websiteRoot),
  run("pnpm", ["exec", "eleventy", "--serve", "--config", "eleventy.config.mjs", "--watch", "--port=7070"], websiteRoot),
]);
