import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { expect } from "compiler/test/expect";

describe("VS Code color theme", () => {
  it("defines explicit JSX colors for the MyLang theme", async () => {
    const themePath = resolve(process.cwd(), "plugins", "vscode", "themes", "mylang-dark-color-theme.json");
    const theme = JSON.parse(await readFile(themePath, "utf8")) as {
      tokenColors: Array<{ scope: string | string[]; settings: { foreground?: string } }>;
    };

    const jsxTagRule = theme.tokenColors.find((rule) => Array.isArray(rule.scope) && rule.scope.includes("entity.name.tag.mylang"));
    const jsxAttributeRule = theme.tokenColors.find((rule) => rule.scope === "entity.other.attribute-name.mylang");

    expect(jsxTagRule?.settings.foreground).toBe("#4EC9B0");
    expect(jsxAttributeRule?.settings.foreground).toBe("#9CDCFE");
  });

  it("defines richer colors for functions, types, properties, strings, numbers, and comments", async () => {
    const themePath = resolve(process.cwd(), "plugins", "vscode", "themes", "mylang-dark-color-theme.json");
    const theme = JSON.parse(await readFile(themePath, "utf8")) as {
      tokenColors: Array<{ scope: string | string[]; settings: { foreground?: string } }>;
    };

    const findRule = (scope: string) => theme.tokenColors.find((rule) =>
      Array.isArray(rule.scope) ? rule.scope.includes(scope) : rule.scope === scope
    );

    expect(findRule("entity.name.function.call.mylang")?.settings.foreground).toBe("#DCDCAA");
    expect(findRule("entity.name.type.mylang")?.settings.foreground).toBe("#4EC9B0");
    expect(findRule("variable.other.property.mylang")?.settings.foreground).toBe("#9CDCFE");
    expect(findRule("string.quoted.template.mylang")?.settings.foreground).toBe("#CE9178");
    expect(findRule("constant.numeric.integer.mylang")?.settings.foreground).toBe("#B5CEA8");
    expect(findRule("comment.line.double-slash.mylang")?.settings.foreground).toBe("#6A9955");
  });
});
