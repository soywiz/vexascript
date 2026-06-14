import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./test/expect";

type RootPackageJson = {
  scripts?: Record<string, string>;
};

type VscodePackageJson = {
  icon?: string;
  license?: string;
  repository?: { type?: string; url?: string };
  files?: string[];
  main?: string;
  scripts?: Record<string, string>;
};

describe("VS Code extension packaging", () => {
  it("defines install, bundle, launch, and package wrapper scripts at the repo root", async () => {
    const packageJsonPath = resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as RootPackageJson;

    expect(pkg.scripts?.["vscodeext:install"]).toBe("pnpm --dir plugins/vscode install");
    expect(pkg.scripts?.["vscodeext:bundle"]).toBe("pnpm --dir plugins/vscode run bundle-extension");
    expect(pkg.scripts?.["vscodeext:launch"]).toBe("pnpm --dir plugins/vscode run launch");
    expect(pkg.scripts?.["vscodeext:package"]).toBe("pnpm --dir plugins/vscode run package");
  });

  it("defines the extension setup, bundle, launch, and package scripts in plugins/vscode/package.json", async () => {
    const packageJsonPath = resolve(process.cwd(), "plugins", "vscode", "package.json");
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as VscodePackageJson;

    expect(pkg.icon).toBe("icons/vexa-file.png");
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.repository).toEqual({
      type: "git",
      url: "https://github.com/soywiz/vexascript.git"
    });
    expect(pkg.files).toEqual([
      "dist/**",
      "icons/**",
      "syntaxes/**",
      "themes/**",
      "language-configuration.json",
      "LICENSE",
      "README.md",
      "package.json"
    ]);
    expect(pkg.main).toBe("./dist/extension.js");
    expect(pkg.scripts?.["setup"]).toBe("CI=true pnpm install");
    expect(pkg.scripts?.["bundle-server"]).toBe(
      "rm -rf dist && mkdir -p dist && pnpm --dir ../.. exec esbuild compiler/lsp/server.ts --bundle --platform=node --format=esm --target=node20 --outfile=plugins/vscode/dist/vexa.mjs --sourcemap --external:vscode-languageserver --external:vscode-languageserver/node.js --external:vscode-languageserver-textdocument --banner:js='#!/usr/bin/env node' --log-level=error && cp ../../compiler/runtime/es2025.d.ts dist/es2025.d.ts && cp ../../compiler/runtime/dom.d.ts dist/dom.d.ts && chmod +x dist/vexa.mjs"
    );
    expect(pkg.scripts?.["stage-server-deps"]).toBe(
      "node scripts/stageServerDeps.mjs"
    );
    expect(pkg.scripts?.["bundle-client"]).toBe(
      "pnpm exec esbuild extension.js --bundle --platform=node --format=cjs --external:vscode --outfile=dist/extension.js"
    );
    expect(pkg.scripts?.["bundle-extension"]).toBe(
      "pnpm run bundle-server && pnpm run stage-server-deps && pnpm run bundle-client"
    );
    expect(pkg.scripts?.["launch"]).toBe(
      "pnpm run bundle-extension && code --extensionDevelopmentPath=$(pwd)"
    );
    expect(pkg.scripts?.["package"]).toBe(
      "pnpm run bundle-extension && pnpm dlx @vscode/vsce package --no-dependencies --out vexascript.vsix"
    );
  });

  it("launches the packaged extension server from the extension dist directory", async () => {
    const extensionPath = resolve(process.cwd(), "plugins", "vscode", "extension.js");
    const extensionSource = await readFile(extensionPath, "utf8");

    expect(extensionSource).toContain("context.extensionPath");
    expect(extensionSource).toContain('"dist"');
    expect(extensionSource).toContain('"vexa.mjs"');
    expect(extensionSource).not.toContain('".."');
  });
});
