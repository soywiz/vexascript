import { describe, expect, it, readFile, resolve } from "./test/expect";

type RootPackageJson = {
  version?: string;
  scripts?: Record<string, string>;
};

type VscodePackageJson = {
  version?: string;
  icon?: string;
  license?: string;
  repository?: { type?: string; url?: string };
  files?: string[];
  main?: string;
  scripts?: Record<string, string>;
};

describe("VS Code extension packaging", () => {
  it("keeps the extension version aligned with the compiler package", async () => {
    const [rootPackage, extensionPackage] = await Promise.all([
      readFile(resolve(process.cwd(), "package.json"), "utf8"),
      readFile(resolve(process.cwd(), "plugins", "vscode", "package.json"), "utf8"),
    ]);
    const root = JSON.parse(rootPackage) as RootPackageJson;
    const extension = JSON.parse(extensionPackage) as VscodePackageJson;

    expect(extension.version).toBe(root.version);
  });

  it("defines release and VS Code extension wrapper scripts at the repo root", async () => {
    const packageJsonPath = resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as RootPackageJson;

    expect(pkg.scripts?.["bump"]).toBe("tsx scripts/bumpVersion.ts");
    expect(pkg.scripts?.["vscodeext:install"]).toBe("pnpm --dir plugins/vscode run install");
    expect(pkg.scripts?.["vscodeext:uninstall"]).toBe("pnpm --dir plugins/vscode run uninstall");
    expect(pkg.scripts?.["vscodeext:bundle"]).toBe("pnpm --dir plugins/vscode run bundle-extension");
    expect(pkg.scripts?.["vscodeext:launch"]).toBe("pnpm --dir plugins/vscode run launch");
    expect(pkg.scripts?.["vscodeext:package"]).toBe("pnpm --dir plugins/vscode run package");
    expect(pkg.scripts?.["code"]).toBe(pkg.scripts?.["vscodeext:launch"]);
    expect(pkg.scripts?.["code:install"]).toBe(pkg.scripts?.["vscodeext:install"]);
    expect(pkg.scripts?.["code:uninstall"]).toBe(pkg.scripts?.["vscodeext:uninstall"]);
    expect(pkg.scripts?.["code:package"]).toBe(pkg.scripts?.["vscodeext:package"]);
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
      "pnpm --dir ../.. exec node --import tsx scripts/buildVscodeServer.ts"
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
    expect(pkg.scripts?.["install"]).toBe(
      "pnpm package && (NODE_OPTIONS=--disable-warning=DEP0169 code --uninstall-extension soywiz.vexascript-vscodeext || true) && NODE_OPTIONS=--disable-warning=DEP0169 code --install-extension vexascript.vsix --force"
    );
    expect(pkg.scripts?.["uninstall"]).toBe(
      "NODE_OPTIONS=--disable-warning=DEP0169 code --uninstall-extension soywiz.vexascript-vscodeext"
    );
  });

  it("launches the packaged extension server from the extension dist directory", async () => {
    const extensionPath = resolve(process.cwd(), "plugins", "vscode", "extension.js");
    const extensionSource = await readFile(extensionPath, "utf8");
    const serverSource = await readFile(resolve(process.cwd(), "compiler", "lsp", "server.ts"), "utf8");

    expect(extensionSource).toContain("context.extensionPath");
    expect(extensionSource).toContain('"dist"');
    expect(extensionSource).toContain('"vexa.mjs"');
    expect(extensionSource).not.toContain('".."');
    expect(serverSource).toContain("setVfs(new NodeServerVfs());");
  });
});
