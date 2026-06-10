import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MarkdownIt = require("../node_modules/.pnpm/markdown-it@14.2.0/node_modules/markdown-it/dist/index.cjs.js");

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false
});

export async function loadSyntaxDocument(projectRoot) {
  return await readFile(resolve(projectRoot, "docs/syntax.md"), "utf8");
}

export function renderMarkdownDocument(content) {
  return markdown.render(content);
}
