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
});
