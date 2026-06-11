import { ensureGeneratedSyntaxModule, run, websiteRoot } from "./prepare.ts";

await ensureGeneratedSyntaxModule();
await run("pnpm", ["exec", "vite", "build", "--config", "vite.playground.config.ts"], websiteRoot);
await run("pnpm", ["exec", "eleventy", "--serve", "--config", "eleventy.config.mjs", "--watch"], websiteRoot);
