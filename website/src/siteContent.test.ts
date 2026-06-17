import { assert, dirname, fileURLToPath, resolve, test } from "../../compiler/test/expect";
import { loadSyntaxDocument, loadSyntaxAiDocument, renderMarkdownDocument } from "./siteContent.ts";
import { highlightVexaScriptHtml } from "./syntaxHighlight.ts";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, "..", "..");

test("loadSyntaxDocument reads the canonical syntax reference", async () => {
  const content = await loadSyntaxDocument(projectRoot);

  assert.match(content, /^# VexaScript Supported Syntax/m);
  assert.match(content, /## Variables/m);
});

test("loadSyntaxAiDocument reads the VexaScript AI syntax reference", async () => {
  const content = await loadSyntaxAiDocument(projectRoot);

  assert.match(content, /^# VexaScript for AI Agents/m);
  assert.match(content, /## Functions/m);
  assert.match(content, /sync fun/m);
});

test("renderMarkdownDocument renders headings and fenced code blocks", () => {
  const html = renderMarkdownDocument("# Title\n\n```vexa\nlet value = 1\n```\n");

  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<pre class="syntax-block"><code class="language-vexa">/);
  assert.match(html, /token-keyword-declaration/);
  assert.match(html, /token-number/);
});

test("highlightVexaScriptHtml applies shared token classes", () => {
  const html = highlightVexaScriptHtml("sync fun load(): int {\n  return 1\n}");

  assert.match(html, /token-keyword-declaration/);
  assert.match(html, /token-keyword-control/);
  assert.match(html, /token-number/);
});
