import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./test/expect";
import {
  createCodeMirrorLegacyModeSource,
  createPortableLanguageConfiguration,
  createPortableMonarchLanguage,
  createVscodeLanguageConfiguration,
  createVscodeTmLanguageGrammar,
  renderSyntaxTarget,
} from "./syntax";

describe("shared syntax generators", () => {
  it("matches the checked-in VS Code TextMate grammar", async () => {
    const grammarPath = resolve(process.cwd(), "plugins", "vscode", "syntaxes", "vexa.tmLanguage.json");
    const expected = `${JSON.stringify(createVscodeTmLanguageGrammar(), null, 2)}\n`;
    expect(await readFile(grammarPath, "utf8")).toBe(expected);
  });

  it("matches the checked-in VS Code language configuration", async () => {
    const configPath = resolve(process.cwd(), "plugins", "vscode", "language-configuration.json");
    const expected = `${JSON.stringify(createVscodeLanguageConfiguration(), null, 2)}\n`;
    expect(await readFile(configPath, "utf8")).toBe(expected);
  });

  it("renders Monaco targets from the same embedded source", () => {
    const monacoLanguage = JSON.parse(renderSyntaxTarget("monaco-language")) as { tokenizer?: unknown };
    const monacoConfiguration = JSON.parse(renderSyntaxTarget("monaco-configuration")) as { comments?: unknown };

    expect(monacoLanguage).toEqual(createPortableMonarchLanguage());
    expect(monacoConfiguration).toEqual(createPortableLanguageConfiguration());
    expect(renderSyntaxTarget("monaco")).toContain("export const vexaMonacoSyntax =");
  });

  it("includes JSX tokenization in VS Code and Monaco syntax definitions", () => {
    const monacoLanguage = createPortableMonarchLanguage();
    const vscodeGrammar = createVscodeTmLanguageGrammar();
    const repository = vscodeGrammar["repository"] as Record<string, unknown>;
    const jsxAttributes = repository["jsx-attributes"] as { patterns: Array<Record<string, unknown>> };

    expect(monacoLanguage.tokenizer["root"]).toContainEqual({
      match: String.raw`(?<![\w)\]])<\/?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`,
      token: "tag",
      next: "@jsx_tag",
    });
    expect(monacoLanguage.tokenizer["jsx_tag"]).toContainEqual({
      match: String.raw`[A-Za-z_$][\w$:-]*(?=\s*=)`,
      token: "attribute.name",
    });
    expect(monacoLanguage.tokenizer["jsx_expression"]).toContainEqual({
      match: String.raw`\}`,
      token: "delimiter.bracket",
      next: "@pop",
    });
    expect(jsxAttributes.patterns).toContainEqual({
      match: "([_$A-Za-z][-_:$A-Za-z0-9]*)(?=\\s*=)",
      name: "entity.other.attribute-name.vexa",
    });
  });

  it("does not treat generic type arguments as JSX in Monaco syntax", () => {
    const monacoLanguage = createPortableMonarchLanguage();
    const rootRules = monacoLanguage.tokenizer["root"] ?? [];
    const jsxStartRule = rootRules.find((rule) =>
      rule.token === "tag" && rule.next === "@jsx_tag" && rule.match.includes("<")
    );
    const source = "declare fun fetch(str: string): Promise<ArrayBuffer>";

    expect(jsxStartRule).toBeDefined();

    const jsxStartRuleMatch = jsxStartRule?.match ?? "";
    const jsxStartRegex = new RegExp(jsxStartRuleMatch, "my");
    jsxStartRegex.lastIndex = source.indexOf("<");
    expect(jsxStartRegex.exec(source)).toBe(null);

    const jsxSource = "return <FetchView />";
    jsxStartRegex.lastIndex = jsxSource.indexOf("<");
    expect(jsxStartRegex.exec(jsxSource)?.[0]).toBe("<FetchView");
  });

  it("renders CodeMirror legacy mode source", () => {
    expect(renderSyntaxTarget("codemirror-legacy")).toBe(createCodeMirrorLegacyModeSource());
    expect(renderSyntaxTarget("codemirror-legacy")).toContain("export const vexaMode =");
  });
});
