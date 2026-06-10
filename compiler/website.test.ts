import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { expect } from "./test/expect";

describe("website project", () => {
  it("documents and exposes both MyLang Monaco embedding modes", async () => {
    const [embedSource, landingPage] = await Promise.all([
      readFile("website/src/assets/mylang-embed.ts", "utf8"),
      readFile("website/src/index.njk", "utf8"),
    ]);

    expect(embedSource.includes("createSimpleEditor")).toBe(true);
    expect(embedSource.includes("createWorkspaceEditor")).toBe(true);
    expect(landingPage.includes("MyLangEmbeds.createSimpleEditor")).toBe(true);
    expect(landingPage.includes("MyLangEmbeds.createWorkspaceEditor")).toBe(true);
  });

  it("keeps the website build wired through Vite and 11ty after preparing the compiler bundle", async () => {
    const [buildScript, packageJsonText] = await Promise.all([
      readFile("website/scripts/build.ts", "utf8"),
      readFile("website/package.json", "utf8"),
    ]);
    const packageJson = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["build"]).toBe("tsx scripts/build.ts");
    expect(buildScript.includes("ensureCompilerBundle")).toBe(true);
    expect(buildScript.includes("eleventy")).toBe(true);
    expect(buildScript.includes("vite")).toBe(true);
  });
});
