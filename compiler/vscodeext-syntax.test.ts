import { describe, expect, it, readFile, resolve } from "./test/expect";
import { fileExists } from "./utils/fs";

type VscodeExtPackage = {
  icon?: string;
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
  it("registers VexaScript language configuration and grammar", async () => {
    const extRoot = resolve(process.cwd(), "plugins", "vscode");
    const packageJsonPath = resolve(extRoot, "package.json");
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as VscodeExtPackage;

    expect(pkg.icon).toBe("icons/vexa-file.png");
    const language = pkg.contributes?.languages?.find((item) => item.id === "vexa");
    expect(language).toBeDefined();
    expect(language?.configuration).toBe("./language-configuration.json");
    expect(language?.icon?.light).toBe("./icons/vexa-file.svg");
    expect(language?.icon?.dark).toBe("./icons/vexa-file.svg");
    expect(pkg.contributes?.iconThemes).toBeUndefined();
    expect(await fileExists(resolve(extRoot, "language-configuration.json"))).toBe(true);
    expect(await fileExists(resolve(extRoot, "icons", "vexa-file.svg"))).toBe(true);

    const grammar = pkg.contributes?.grammars?.find((item) => item.language === "vexa");
    expect(grammar).toBeDefined();
    expect(grammar?.scopeName).toBe("source.vexa");
    expect(grammar?.path).toBe("./syntaxes/vexa.tmLanguage.json");
    expect(await fileExists(resolve(extRoot, "syntaxes", "vexa.tmLanguage.json"))).toBe(true);
  });

  it("includes core keyword/string/operator patterns in grammar", async () => {
    const grammarPath = resolve(import.meta.dirname, "../plugins/vscode/syntaxes/vexa.tmLanguage.json");
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
    expect(keywordPatterns.join(" ")).toContain("export");
    expect(keywordPatterns.join(" ")).toContain("from");
    expect(keywordPatterns.join(" ")).toContain("var");
    expect(keywordPatterns.join(" ")).toContain("val");
    expect(keywordPatterns.join(" ")).toContain("const");
    expect(keywordPatterns.join(" ")).toContain("function");
    expect(keywordPatterns.join(" ")).toContain("fun");
    expect(keywordPatterns.join(" ")).toContain("declare");
    expect(keywordPatterns.join(" ")).toContain("namespace");
    expect(keywordPatterns.join(" ")).toContain("class");
    expect(keywordPatterns.join(" ")).toContain("interface");
    expect(keywordPatterns.join(" ")).toContain("extends");
    expect(keywordPatterns.join(" ")).toContain("keyof");
    expect(keywordPatterns.join(" ")).toContain("infer");
    expect(keywordPatterns.join(" ")).toContain("implements");
    expect(keywordPatterns.join(" ")).toContain("override");
    expect(keywordPatterns.join(" ")).toContain("public");
    expect(keywordPatterns.join(" ")).toContain("private");
    expect(keywordPatterns.join(" ")).toContain("protected");
    expect(keywordPatterns.join(" ")).toContain("static");
    expect(keywordPatterns.join(" ")).toContain("abstract");
    expect(keywordPatterns.join(" ")).toContain("get");
    expect(keywordPatterns.join(" ")).toContain("set");
    expect(keywordPatterns.join(" ")).toContain("do");
    expect(keywordPatterns.join(" ")).toContain("switch");
    expect(keywordPatterns.join(" ")).toContain("case");
    expect(keywordPatterns.join(" ")).toContain("default");
    expect(keywordPatterns.join(" ")).toContain("throw");
    expect(keywordPatterns.join(" ")).toContain("try");
    expect(keywordPatterns.join(" ")).toContain("catch");
    expect(keywordPatterns.join(" ")).toContain("finally");
    expect(keywordPatterns.join(" ")).toContain("defer");
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

  it("includes triple-slash documentation comment highlighting", async () => {
    const grammarPath = resolve(import.meta.dirname, "../plugins/vscode/syntaxes/vexa.tmLanguage.json");
    const grammar = JSON.parse(await readFile(grammarPath, "utf8")) as {
      repository?: Record<string, { patterns?: Array<{ name?: string; begin?: string }> }>;
    };

    const commentPatterns = grammar.repository?.["comments"]?.patterns ?? [];
    expect(commentPatterns.some((pattern) =>
      pattern.name === "comment.line.documentation.vexa" && pattern.begin === "///"
    )).toBe(true);
    expect(JSON.stringify(grammar.repository)).toContain("variable.parameter.documentation.vexa");
  });

  it("includes embedded XML/JSX highlighting patterns", async () => {
    const grammarPath = resolve(import.meta.dirname, "../plugins/vscode/syntaxes/vexa.tmLanguage.json");
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
    expect(serialized).toContain("entity.name.tag.vexa");
    expect(serialized).toContain("entity.other.attribute-name.vexa");
  });

  it("includes richer declaration, type, property, call, and template-string scopes", async () => {
    const grammarPath = resolve(import.meta.dirname, "../plugins/vscode/syntaxes/vexa.tmLanguage.json");
    const grammar = JSON.parse(await readFile(grammarPath, "utf8")) as {
      patterns?: Array<{ include?: string }>;
      repository?: Record<string, { patterns?: Array<{ name?: string; match?: string; include?: string }> }>;
    };

    const topLevelIncludes = (grammar.patterns ?? []).map((pattern) => pattern.include);
    expect(topLevelIncludes).toContain("#declarations");
    expect(topLevelIncludes).toContain("#types");
    expect(topLevelIncludes).toContain("#members");
    expect(topLevelIncludes).toContain("#calls");

    const repository = grammar.repository ?? {};
    expect(repository["declarations"]?.patterns?.some((pattern) => pattern.match?.includes("(function|fun)"))).toBe(true);
    expect(repository["declarations"]?.patterns?.some((pattern) => pattern.match?.includes("(class|interface|annotation|enum|type)"))).toBe(true);
    expect(repository["types"]?.patterns?.some((pattern) => pattern.name === "entity.name.type.vexa")).toBe(true);
    expect(repository["members"]?.patterns?.some((pattern) => pattern.name === "variable.other.property.vexa")).toBe(true);
    expect(repository["calls"]?.patterns?.some((pattern) => pattern.name === "entity.name.function.call.vexa")).toBe(true);
    expect(repository["template-interpolation"]).toBeDefined();

    const serialized = JSON.stringify(repository);
    expect(serialized).toContain("string.quoted.template.vexa");
    expect(serialized).toContain("meta.template.expression.vexa");
    expect(serialized).toContain("support.type.primitive.vexa");
  });
});
