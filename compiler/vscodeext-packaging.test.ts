import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./test/expect";

type RootPackageJson = {
  scripts?: Record<string, string>;
};

type VscodePackageJson = {
  license?: string;
  repository?: { type?: string; url?: string };
  files?: string[];
  scripts?: Record<string, string>;
};

describe("VS Code extension packaging", () => {
  it("defines install, bundle, launch, and package wrapper scripts at the repo root", async () => {
    const packageJsonPath = resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as RootPackageJson;

    expect(pkg.scripts?.["vscodeext:install"]).toBe("pnpm --dir plugins/vscode install");
    expect(pkg.scripts?.["vscodeext:bundle"]).toBe("pnpm --dir plugins/vscode run bundle-server");
    expect(pkg.scripts?.["vscodeext:launch"]).toBe("pnpm --dir plugins/vscode run launch");
    expect(pkg.scripts?.["vscodeext:package"]).toBe("pnpm --dir plugins/vscode run package");
  });

  it("defines the extension setup, bundle, launch, and package scripts in plugins/vscode/package.json", async () => {
    const packageJsonPath = resolve(process.cwd(), "plugins", "vscode", "package.json");
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as VscodePackageJson;

    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.repository).toEqual({
      type: "git",
      url: "https://github.com/soywiz/mylang.git"
    });
    expect(pkg.files).toEqual([
      "dist/**",
      "icons/**",
      "syntaxes/**",
      "themes/**",
      "extension.js",
      "language-configuration.json",
      "LICENSE",
      "README.md",
      "package.json"
    ]);
    expect(pkg.scripts?.["setup"]).toBe("CI=true pnpm install");
    expect(pkg.scripts?.["bundle-server"]).toBe(
      "pnpm --dir ../.. build && mkdir -p dist && cp ../../dist/mylang.js ../../dist/mylang.js.map ../../dist/es2025.d.ts ../../dist/dom.d.ts dist/"
    );
    expect(pkg.scripts?.["launch"]).toBe(
      "pnpm run bundle-server && code --extensionDevelopmentPath=$(pwd)"
    );
    expect(pkg.scripts?.["package"]).toBe(
      "pnpm run bundle-server && pnpm dlx @vscode/vsce package --no-dependencies --out mylang-vscodeext.vsix"
    );
  });

  it("launches the packaged extension server from the extension dist directory", async () => {
    const extensionPath = resolve(process.cwd(), "plugins", "vscode", "extension.js");
    const extensionSource = await readFile(extensionPath, "utf8");

    expect(extensionSource).toContain("context.extensionPath");
    expect(extensionSource).toContain('"dist"');
    expect(extensionSource).toContain('"mylang.js"');
    expect(extensionSource).not.toContain('".."');
  });
});
