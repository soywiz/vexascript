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
    const grammarPath = resolve(process.cwd(), "plugins", "vscode", "syntaxes", "mylang.tmLanguage.json");
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
    expect(renderSyntaxTarget("monaco")).toContain("export const mylangMonacoSyntax =");
  });

  it("renders CodeMirror legacy mode source", () => {
    expect(renderSyntaxTarget("codemirror-legacy")).toBe(createCodeMirrorLegacyModeSource());
    expect(renderSyntaxTarget("codemirror-legacy")).toContain("export const mylangMode =");
  });
});
