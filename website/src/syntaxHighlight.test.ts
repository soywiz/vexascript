import { describe, expect, it } from "../../compiler/test/expect";
import { highlightVexaScriptHtml } from "./syntaxHighlight";

describe("website syntax highlighting", () => {
  it("highlights template strings and their shorthand interpolations", () => {
    const html = highlightVexaScriptHtml("val path = `/api/users/$id`");

    expect(html.match(/<span class="token-string">`<\/span>/g) ?? []).toHaveLength(2);
    expect(html).toContain('<span class="token-string">/api/users/</span>');
    expect(html).toContain('<span class="token-operator">$</span><span class="token-identifier">id</span>');
  });

  it("keeps braced interpolation expressions highlighted as code", () => {
    const html = highlightVexaScriptHtml("val path = `/api/users/${id}`");

    expect(html).toContain('<span class="token-string">/api/users/</span>');
    expect(html).toContain('<span class="token-delimiter">${</span>');
    expect(html).toContain('<span class="token-identifier">id</span>');
  });
});
