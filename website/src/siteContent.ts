import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import MarkdownIt from "markdown-it";
import { renderHighlightedCodeBlock } from "./syntaxHighlight.ts";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  highlight(content: string, language: string) {
    return renderHighlightedCodeBlock(content, language || "vexa");
  }
});

export async function loadSyntaxDocument(projectRoot) {
  return await readFile(resolve(projectRoot, "docs/syntax.md"), "utf8");
}

export async function loadDifferencesDocument(projectRoot) {
  return await readFile(resolve(projectRoot, "docs/vexa_syntax_differences.md"), "utf8");
}

export async function loadAgentsDocument(projectRoot) {
  return await readFile(resolve(projectRoot, "docs/agents-vexascript.md"), "utf8");
}

export function renderMarkdownDocument(content) {
  return markdown.render(content);
}
