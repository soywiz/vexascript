import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "compiler/test/expect";

describe("VS Code color theme", () => {
  async function readTheme() {
    const themePath = resolve(process.cwd(), "plugins", "vscode", "themes", "vexa-dark-color-theme.json");
    return JSON.parse(await readFile(themePath, "utf8")) as {
      semanticHighlighting?: boolean;
      semanticTokenColors?: Record<string, string>;
      tokenColors: Array<{ scope: string | string[]; settings: { foreground?: string } }>;
    };
  }

  it("defines explicit JSX colors for the VexaScript theme", async () => {
    const theme = await readTheme();

    const jsxTagRule = theme.tokenColors.find((rule) => Array.isArray(rule.scope) && rule.scope.includes("entity.name.tag.vexa"));
    const jsxAttributeRule = theme.tokenColors.find((rule) => rule.scope === "entity.other.attribute-name.vexa");

    expect(jsxTagRule?.settings.foreground).toBe("#4EC9B0");
    expect(jsxAttributeRule?.settings.foreground).toBe("#9CDCFE");
  });

  it("defines richer colors for functions, types, properties, strings, numbers, and comments", async () => {
    const theme = await readTheme();

    const findRule = (scope: string) => theme.tokenColors.find((rule) =>
      Array.isArray(rule.scope) ? rule.scope.includes(scope) : rule.scope === scope
    );

    expect(findRule("entity.name.function.call.vexa")?.settings.foreground).toBe("#DCDCAA");
    expect(findRule("entity.name.type.vexa")?.settings.foreground).toBe("#4EC9B0");
    expect(findRule("variable.other.property.vexa")?.settings.foreground).toBe("#9CDCFE");
    expect(findRule("variable.parameter.documentation.vexa")?.settings.foreground).toBe("#D7BA7D");
    expect(findRule("string.quoted.template.vexa")?.settings.foreground).toBe("#CE9178");
    expect(findRule("constant.numeric.integer.vexa")?.settings.foreground).toBe("#B5CEA8");
    expect(findRule("comment.line.double-slash.vexa")?.settings.foreground).toBe("#6A9955");
  });

  it("colors declaration modifiers with the declaration keyword scope", async () => {
    const theme = await readTheme();

    const findRule = (scope: string) => theme.tokenColors.find((rule) =>
      Array.isArray(rule.scope) ? rule.scope.includes(scope) : rule.scope === scope
    );

    expect(findRule("keyword.declaration.vexa")?.settings.foreground).toBe("#569CD6");
  });

  it("defines separate semantic colors for modifier, function, type, and control keywords", async () => {
    const theme = await readTheme();

    expect(theme.semanticHighlighting).toBe(true);
    expect(theme.semanticTokenColors?.["keywordModifier"]).toBe("#569CD6");
    expect(theme.semanticTokenColors?.["keywordFunction"]).toBe("#DCDCAA");
    expect(theme.semanticTokenColors?.["keywordType"]).toBe("#4EC9B0");
    expect(theme.semanticTokenColors?.["keywordControl"]).toBe("#C586C0");
  });

  it("recolors template interpolations like regular expressions instead of plain strings", async () => {
    const theme = await readTheme();

    const findRule = (scope: string) => theme.tokenColors.find((rule) =>
      Array.isArray(rule.scope) ? rule.scope.includes(scope) : rule.scope === scope
    );

    expect(findRule("meta.template.expression.vexa variable.other.vexa")?.settings.foreground).toBe("#D4D4D4");
    expect(findRule("meta.template.expression.vexa variable.other.property.vexa")?.settings.foreground).toBe("#9CDCFE");
    expect(findRule("meta.template.expression.vexa entity.name.function.call.vexa")?.settings.foreground).toBe("#DCDCAA");
  });
});
