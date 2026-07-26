import { readFile } from "node:fs/promises";
import { assert, dirname, fileURLToPath, resolve, test } from "../../compiler/test/expect";
import { ensureGeneratedSyntaxModule } from "../scripts/prepare.ts";
import { loadSyntaxDocument, loadSyntaxAiDocument, renderMarkdownDocument } from "./siteContent.ts";
import { highlightVexaScriptHtml } from "./syntaxHighlight.ts";

let builtHighlighterPromise: Promise<typeof import("./syntaxHighlight.mjs")> | undefined;

function loadBuiltHighlighter(): Promise<typeof import("./syntaxHighlight.mjs")> {
  builtHighlighterPromise ??= (async () => {
    await ensureGeneratedSyntaxModule();
    return await import("./syntaxHighlight.mjs");
  })();
  return builtHighlighterPromise;
}

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

test("renderMarkdownDocument highlights TypeScript blocks with the shared lexer", () => {
  const html = renderMarkdownDocument("```typescript\nconst value: string = \"hello\"\n```\n");

  assert.match(html, /language-typescript/);
  assert.match(html, /class="token-keyword-declaration">const<\/span>/);
  assert.match(html, /class="token-string">"hello"<\/span>/);
});

test("highlightVexaScriptHtml applies shared token classes", () => {
  const html = highlightVexaScriptHtml("class Point {}\nsync fun load(): int {\n  const value = 1\n  return value\n}");

  assert.match(html, /class="token-keyword-type">class<\/span>/);
  assert.match(html, /class="token-keyword-modifier">sync<\/span>/);
  assert.match(html, /class="token-keyword-modifier">fun<\/span>/);
  assert.match(html, /class="token-keyword-declaration">const<\/span>/);
  assert.match(html, /token-keyword-control/);
  assert.match(html, /token-number/);
});

test("highlightVexaScriptHtml limits documentation comments to one line", () => {
  const html = highlightVexaScriptHtml("/// Point documentation\nclass Point {}\nconst value = 1");

  assert.match(html, /class="token-comment-doc"> Point documentation<\/span>/);
  assert.match(html, /class="token-keyword-type">class<\/span>/);
  assert.match(html, /class="token-keyword-declaration">const<\/span>/);
  assert.doesNotMatch(html, /token-comment-doc[^<]*[\r\n][\s\S]*token-keyword/);
});

test("the Eleventy highlighter uses the same keyword and comment rules", () => {
  return loadBuiltHighlighter().then(({ highlightVexaScriptHtml: highlightBuiltVexaScriptHtml }) => {
    const html = highlightBuiltVexaScriptHtml("/// docs\nclass Point {}\nsync fun load(): int {\n  const value = 1\n}");

    assert.match(html, /class="token-keyword-type">class<\/span>/);
    assert.match(html, /class="token-keyword-modifier">sync<\/span>/);
    assert.match(html, /class="token-keyword-modifier">fun<\/span>/);
    assert.match(html, /class="token-keyword-declaration">const<\/span>/);
    assert.doesNotMatch(html, /token-comment-doc[^<]*[\r\n][\s\S]*token-keyword/);
  });
});

test("the Eleventy highlighter also handles TypeScript blocks", async () => {
  const { renderHighlightedCodeBlock: renderBuiltCodeBlock } = await loadBuiltHighlighter();
  const html = renderBuiltCodeBlock("const value: string = \"hello\"", "ts");

  assert.match(html, /language-ts/);
  assert.match(html, /class="token-keyword-declaration">const<\/span>/);
});

test("blog single-column content is centered in the listing and article views", async () => {
  const css = await readFile(resolve(testDirectory, "assets/site.css"), "utf8");

  assert.match(css, /\.blog-list \.card \{[\s\S]*?width: 100%;[\s\S]*?margin-inline: auto;/);
  assert.match(css, /\.blog-article \{[\s\S]*?width: 100%;[\s\S]*?margin-inline: auto;/);
  assert.match(css, /\.blog-article table \{[\s\S]*?max-width: 100%;[\s\S]*?overflow-x: auto;/);
});

test("embed example cards scroll independently", async () => {
  const css = await readFile(resolve(testDirectory, "assets/site.css"), "utf8");

  assert.match(css, /\.embed-docs \.card pre \{[\s\S]*?height: min\(24rem, calc\(100vh - 12rem\)\);[\s\S]*?overflow-x: auto;[\s\S]*?overflow-y: hidden;/);
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
