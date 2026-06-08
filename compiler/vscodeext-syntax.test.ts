import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./test/expect";
import { fileExists } from "./utils/io";

type VscodeExtPackage = {
  contributes?: {
    languages?: Array<{
      id?: string;
      configuration?: string;
      icon?: { light?: string; dark?: string };
    }>;
    grammars?: Array<{ language?: string; scopeName?: string; path?: string }>;
    iconThemes?: Array<unknown>;
  };
};

describe("VS Code extension syntax highlighting", () => {
  it("registers MyLang language configuration and grammar", async () => {
    const extRoot = resolve(process.cwd(), "plugins", "vscode");
    const packageJsonPath = resolve(extRoot, "package.json");
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as VscodeExtPackage;

    const language = pkg.contributes?.languages?.find((item) => item.id === "mylang");
    expect(language).toBeDefined();
    expect(language?.configuration).toBe("./language-configuration.json");
    expect(language?.icon?.light).toBe("./icons/mylang-file.svg");
    expect(language?.icon?.dark).toBe("./icons/mylang-file.svg");
    expect(pkg.contributes?.iconThemes).toBeUndefined();
    expect(await fileExists(resolve(extRoot, "language-configuration.json"))).toBe(true);
    expect(await fileExists(resolve(extRoot, "icons", "mylang-file.svg"))).toBe(true);

    const grammar = pkg.contributes?.grammars?.find((item) => item.language === "mylang");
    expect(grammar).toBeDefined();
    expect(grammar?.scopeName).toBe("source.mylang");
    expect(grammar?.path).toBe("./syntaxes/mylang.tmLanguage.json");
    expect(await fileExists(resolve(extRoot, "syntaxes", "mylang.tmLanguage.json"))).toBe(true);
  });

  it("includes core keyword/string/operator patterns in grammar", async () => {
    const grammarPath = resolve(import.meta.dirname, "../plugins/vscode/syntaxes/mylang.tmLanguage.json");
    const grammar = JSON.parse(await readFile(grammarPath, "utf8")) as {
      repository?: Record<string, { patterns?: Array<{ match?: string }> }>;
    };

    const keywordPatterns = grammar.repository?.["keywords"]?.patterns?.map((pattern) => pattern.match) ?? [];
    const operatorPatterns = grammar.repository?.["operators"]?.patterns?.map((pattern) => pattern.match) ?? [];
    const regexpPatterns = grammar.repository?.["regexps"]?.patterns?.map((pattern) => pattern.match) ?? [];
    const stringEscapeMatch =
      (
        grammar.repository?.["strings"] as
          | { patterns?: Array<{ patterns?: Array<{ match?: string }> }> }
          | undefined
      )?.patterns?.[0]?.patterns?.[0]?.match ?? "";

    expect(keywordPatterns.join(" ")).toContain("let");
    expect(keywordPatterns.join(" ")).toContain("import");
    expect(keywordPatterns.join(" ")).toContain("from");
    expect(keywordPatterns.join(" ")).toContain("var");
    expect(keywordPatterns.join(" ")).toContain("val");
    expect(keywordPatterns.join(" ")).toContain("const");
    expect(keywordPatterns.join(" ")).toContain("function");
    expect(keywordPatterns.join(" ")).toContain("fun");
    expect(keywordPatterns.join(" ")).toContain("declare");
    expect(keywordPatterns.join(" ")).toContain("class");
    expect(keywordPatterns.join(" ")).toContain("interface");
    expect(keywordPatterns.join(" ")).toContain("extends");
    expect(keywordPatterns.join(" ")).toContain("keyof");
    expect(keywordPatterns.join(" ")).toContain("infer");
    expect(keywordPatterns.join(" ")).toContain("implements");
    expect(keywordPatterns.join(" ")).toContain("override");
    expect(keywordPatterns.join(" ")).toContain("do");
    expect(keywordPatterns.join(" ")).toContain("switch");
    expect(keywordPatterns.join(" ")).toContain("case");
    expect(keywordPatterns.join(" ")).toContain("default");
    expect(keywordPatterns.join(" ")).toContain("throw");
    expect(keywordPatterns.join(" ")).toContain("try");
    expect(keywordPatterns.join(" ")).toContain("catch");
    expect(keywordPatterns.join(" ")).toContain("finally");
    expect(keywordPatterns.join(" ")).toContain("new");
    expect(keywordPatterns.join(" ")).toContain("in");
    expect(keywordPatterns.join(" ")).toContain("is");
    expect(keywordPatterns.join(" ")).toContain("instanceof");
    expect(keywordPatterns.join(" ")).toContain("typeof");
    expect(keywordPatterns.join(" ")).toContain("void");
    expect(keywordPatterns.join(" ")).toContain("delete");
    expect(keywordPatterns.join(" ")).toContain("await");
    expect(operatorPatterns.join(" ")).toContain("\\+=");
    expect(operatorPatterns.join(" ")).toContain("\\*\\*");
    expect(operatorPatterns.join(" ")).toContain("\\?\\?=");
    expect(operatorPatterns.join(" ")).toContain("\\?\\?");
    expect(regexpPatterns.join(" ")).toContain("/[");
    expect(stringEscapeMatch).toBe("\\\\(?:[nrt'\"\\\\]|u[0-9A-Fa-f]{4})");
  });

  it("includes embedded XML/JSX highlighting patterns", async () => {
    const grammarPath = resolve(import.meta.dirname, "../plugins/vscode/syntaxes/mylang.tmLanguage.json");
    const grammar = JSON.parse(await readFile(grammarPath, "utf8")) as {
      patterns?: Array<{ include?: string }>;
      repository?: Record<string, unknown>;
    };

    // JSX must be reachable from the top-level patterns.
    expect((grammar.patterns ?? []).some((pattern) => pattern.include === "#jsx")).toBe(true);

    const repository = grammar.repository ?? {};
    for (const key of [
      "jsx",
      "jsx-fragment",
      "jsx-self-closing-element",
      "jsx-paired-element",
      "jsx-attributes",
      "jsx-expression"
    ]) {
      expect(Object.prototype.hasOwnProperty.call(repository, key), `grammar repository should define #${key}`).toBe(true);
    }

    const serialized = JSON.stringify(grammar.repository);
    // Tag names and attribute names get dedicated scopes.
    expect(serialized).toContain("entity.name.tag.mylang");
    expect(serialized).toContain("entity.other.attribute-name.mylang");
  });
});
