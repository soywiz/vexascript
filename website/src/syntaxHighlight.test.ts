import { describe, expect, it } from "../../compiler/test/expect";
import { ensureGeneratedSyntaxModule } from "../scripts/prepare";

const highlighter = ensureGeneratedSyntaxModule()
  .then(() => import("./syntaxHighlight.mjs"));

async function highlightVexaScriptHtml(source: string): Promise<string> {
  return (await highlighter).highlightVexaScriptHtml(source);
}

describe("website syntax highlighting", () => {
  it("highlights template strings and their shorthand interpolations", async () => {
    const html = await highlightVexaScriptHtml("val path = `/api/users/$id`");

    expect(html.match(/<span class="token-string">`<\/span>/g) ?? []).toHaveLength(2);
    expect(html).toContain('<span class="token-string">/api/users/</span>');
    expect(html).toContain('<span class="token-operator">$</span><span class="token-identifier">id</span>');
  });

  it("keeps braced interpolation expressions highlighted as code", async () => {
    const html = await highlightVexaScriptHtml("val path = `/api/users/${id}`");

    expect(html).toContain('<span class="token-string">/api/users/</span>');
    expect(html).toContain('<span class="token-delimiter">${</span>');
    expect(html).toContain('<span class="token-identifier">id</span>');
  });

  it("highlights regular-expression literals", async () => {
    const html = await highlightVexaScriptHtml(String.raw`/^user-[0-9]+$/i -> "user id"`);

    expect(html).toContain('<span class="token-regexp-delimiter">/</span>');
    expect(html).toContain('<span class="token-regexp">user-</span>');
    expect(html).toContain('<span class="token-regexp-character-class">[0-9]</span>');
    expect(html).toContain('<span class="token-regexp-special">+</span>');
    expect(html).toContain('<span class="token-regexp-special">$</span>');
    expect(html).toContain('<span class="token-regexp-flag">i</span>');

    const escapedHtml = await highlightVexaScriptHtml(String.raw`/\d+\.com/g`);
    expect(escapedHtml).toContain('<span class="token-regexp-escape">\\d</span>');
    expect(escapedHtml).toContain('<span class="token-regexp-escape">\\.</span>');
  });
});
