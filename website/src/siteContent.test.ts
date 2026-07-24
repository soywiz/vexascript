import { readFile } from "node:fs/promises";
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

test("blog single-column content is centered in the listing and article views", async () => {
  const css = await readFile(resolve(testDirectory, "assets/site.css"), "utf8");

  assert.match(css, /\.blog-list \.card \{[\s\S]*?width: 100%;[\s\S]*?margin-inline: auto;/);
  assert.match(css, /\.blog-article \{[\s\S]*?width: 100%;[\s\S]*?margin-inline: auto;/);
});

test("embed example cards scroll independently", async () => {
  const css = await readFile(resolve(testDirectory, "assets/site.css"), "utf8");

  assert.match(css, /\.embed-docs \.card \{[\s\S]*?height: min\(24rem, calc\(100vh - 12rem\)\);[\s\S]*?overflow-x: auto;[\s\S]*?overflow-y: hidden;/);
  assert.match(css, /\.embed-docs \.syntax-block \{ overflow: visible; \}/);
});

test("embed example cards use the shared VexaScript highlighter", async () => {
  const embed = await readFile(resolve(testDirectory, "embed.njk"), "utf8");

  assert.equal((embed.match(/\{% highlightVexaScript %\}/g) ?? []).length, 3);
  assert.equal((embed.match(/\{% endhighlightVexaScript %\}/g) ?? []).length, 3);
});

test("CLI reference groups native workflows under cpp", async () => {
  const cli = await readFile(resolve(testDirectory, "cli.njk"), "utf8");

  assert.match(cli, /vexa cpp &lt;input&gt;/);
  assert.match(cli, /vexa cpp build &lt;input&gt;/);
  assert.match(cli, /vexa cpp link &lt;input&gt;/);
  assert.match(cli, /vexa cpp run &lt;input&gt;/);
  assert.match(cli, /vexa_workspace_symbols/);
  assert.match(cli, /vexa_document_symbols/);
  assert.match(cli, /vexa_hover/);
  assert.match(cli, /vexa_definition/);
  assert.match(cli, /vexa_references/);
  assert.match(cli, /vexa_signature_help/);
  assert.match(cli, /vexa_rename/);
  assert.doesNotMatch(cli, /vexa executable/);
});
