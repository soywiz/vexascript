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

test("the Preact sample uses delegated mutable state in JSX context", async () => {
  const samples = await readFile(resolve(testDirectory, "samples.njk"), "utf8");

  assert.match(samples, /<h3>JSX with Preact<\/h3>[\s\S]*?import \{ useState \} from "preact\/hooks"/);
  assert.match(samples, /var count by useState\(initial\)/);
  assert.match(samples, /onClick=\{ \{ count\+\+ \} \}/);
});

test("the samples page includes a cross-backend FFI example", async () => {
  const samples = await readFile(resolve(testDirectory, "samples.njk"), "utf8");

  assert.match(samples, /<h2 class="samples-group-heading">Native &amp; Interop<\/h2>/);
  assert.match(samples, /@FFILibrary\("libSystem\.B\.dylib", "libc\.so\.6", "msvcrt\.dll"\)/);
  assert.match(samples, /declare class NativeC \{[\s\S]*?static abs\(value: int\): int/);
  assert.match(samples, /val distance = NativeC\.abs\(-42\)/);
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

test("highlightVexaScriptHtml keeps generic receiver declarations out of JSX state", () => {
  const html = highlightVexaScriptHtml([
    "fun <T> T.apply(block: T.() => T) { block(this); return this }",
    "",
    "class Point(var x: number, var y: number)",
    "val point = Point(10, 20)",
  ].join("\n"));

  assert.doesNotMatch(html, /class="token-tag">&lt;T/);
  assert.match(html, /class="token-keyword-type">class<\/span>/);
  assert.match(html, /class="token-keyword-declaration">var<\/span>/);
  assert.match(html, /class="token-keyword-declaration">val<\/span>/);
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

test("primary navigation stays rendered on desktop and uses a button toggle on mobile", async () => {
  const [layout, css] = await Promise.all([
    readFile(resolve(testDirectory, "_includes/layout.njk"), "utf8"),
    readFile(resolve(testDirectory, "assets/site.css"), "utf8"),
  ]);

  assert.match(layout, /<button class="nav-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="primary-navigation">/);
  assert.match(layout, /<nav id="primary-navigation" class="nav" aria-label="Primary navigation">/);
  assert.doesNotMatch(layout, /<details[^>]*>[\s\S]*?<nav id="primary-navigation"/);
  assert.match(css, /\.nav-toggle \{ display: none; \}/);
  assert.match(css, /\.nav-toggle \+ \.nav \{[\s\S]*?visibility: hidden;[\s\S]*?transform: translateY\(-0\.45rem\) scale\(0\.98\);/);
  assert.match(css, /\.nav-toggle\[aria-expanded="true"\] \+ \.nav \{[\s\S]*?visibility: visible;[\s\S]*?transform: translateY\(0\) scale\(1\);/);
  assert.match(css, /\.nav-toggle\[aria-expanded="true"\] \.nav-toggle-icon span:nth-child\(1\)/);
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
