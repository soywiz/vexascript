import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSyntaxDocument, renderMarkdownDocument } from "./siteContent.ts";
import { highlightMyLangHtml } from "./syntaxHighlight.ts";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, "..", "..");

test("loadSyntaxDocument reads the canonical syntax reference", async () => {
  const content = await loadSyntaxDocument(projectRoot);

  assert.match(content, /^# MyLang Supported Syntax/m);
  assert.match(content, /## Variables/m);
});

test("renderMarkdownDocument renders headings and fenced code blocks", () => {
  const html = renderMarkdownDocument("# Title\n\n```mylang\nlet value = 1\n```\n");

  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<pre class="syntax-block"><code class="language-mylang">/);
  assert.match(html, /token-keyword-declaration/);
  assert.match(html, /token-number/);
});

test("highlightMyLangHtml applies shared token classes", () => {
  const html = highlightMyLangHtml("sync fun load(): int {\n  return 1\n}");

  assert.match(html, /token-keyword-declaration/);
  assert.match(html, /token-keyword-control/);
  assert.match(html, /token-number/);
});
