import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { getNodeModuleTypings, findNodeModuleMemberLocation } from "./nodeModulesTypings";
import { collectImportedTypeDeclarations, collectImportedSymbolTypes } from "./importedDeclarations";
import { createAnalysisSession } from "./analysisSession";
import dedent from "compiler/utils/dedent";
import { namedType } from "compiler/analysis/types";

const MINI_DTS = dedent`
  declare function pkg(x: string): pkg.Result;
  declare namespace pkg {
    interface Result {
      value(): string;
    }
    function helper(): Result;
  }
  export = pkg;
`;

async function makePackageWithTypings(root: string, pkgName: string, dts: string): Promise<string> {
  const pkgDir = join(root, "node_modules", pkgName);
  await mkdir(pkgDir, { recursive: true });
  const dtsPath = join(pkgDir, "index.d.ts");
  await writeFile(dtsPath, dts, "utf8");
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: pkgName, typings: "./index.d.ts" }),
    "utf8"
  );
  return dtsPath;
}

describe("node_modules typings resolution", () => {
  it("resolves typings from node_modules package.json typings field", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const importerPath = join(root, "main.my");
    const typings = getNodeModuleTypings(importerPath, "pkg");

    expect(typings).not.toBeNull();
    expect(typings?.defaultExportName).toBe("pkg");
    expect(typings?.declarations.length).toBeGreaterThan(0);
  });

  it("returns null for unknown packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-nm-typings-"));
    const importerPath = join(root, "main.my");
    const typings = getNodeModuleTypings(importerPath, "nonexistent-pkg");
    expect(typings).toBeNull();
  });

  it("walks up directory tree to find node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);
    const subDir = join(root, "src", "sub");
    await mkdir(subDir, { recursive: true });
    const importerPath = join(subDir, "main.my");

    const typings = getNodeModuleTypings(importerPath, "pkg");
    expect(typings).not.toBeNull();
    expect(typings?.defaultExportName).toBe("pkg");
  });

  it("collectImportedTypeDeclarations loads node_modules declarations for default import", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const mainPath = join(root, "main.my");
    const source = `import pkg from "pkg"\npkg.helper()\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const declarations = collectImportedTypeDeclarations(session.ast!, {
      uri: `file://${mainPath}`,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    const names = declarations.map((d) => {
      const named = d as { name?: { name?: string }; names?: { name: string }[] };
      return named.name?.name ?? named.names?.[0]?.name ?? d.kind;
    });
    expect(names).toContain("pkg");
  });

  it("collectImportedSymbolTypes assigns named type to default import from node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const mainPath = join(root, "main.my");
    const source = `import pkg from "pkg"\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const symbolTypes = collectImportedSymbolTypes(session.ast!, {
      uri: `file://${mainPath}`,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect(symbolTypes.get("pkg")).toEqual(namedType("pkg"));
  });

  it("default import from node_modules gets named type instead of unknown in analysis", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const mainPath = join(root, "main.my");
    const source = `import pkg from "pkg"\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const symbolTypes = collectImportedSymbolTypes(session.ast!, {
      uri: `file://${mainPath}`,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const declarations = collectImportedTypeDeclarations(session.ast!, {
      uri: `file://${mainPath}`,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    const richSession = createAnalysisSession(source, declarations, symbolTypes);

    const symbol = richSession.analysis?.getTopLevelSymbolType("pkg");
    expect(symbol?.kind).toBe("named");
    expect((symbol as { name?: string })?.name).toBe("pkg");
  });

  it("findNodeModuleMemberLocation finds a member inside a namespace", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const importerPath = join(root, "main.my");

    const result = findNodeModuleMemberLocation(importerPath, "pkg", "pkg", "helper");
    expect(result).not.toBeNull();
    expect(result?.typingsPath).toContain("index.d.ts");
    expect(result?.range.start.line).toBeGreaterThanOrEqual(0);
  });

  it("findNodeModuleMemberLocation returns null for non-existent member", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const importerPath = join(root, "main.my");
    const result = findNodeModuleMemberLocation(importerPath, "pkg", "pkg", "nonExistent");
    expect(result).toBeNull();
  });

  it("resolves namespace members from node_modules typings for member access hover", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const mainPath = join(root, "main.my");
    const source = `import pkg from "pkg"\npkg.helper()\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const symbolTypes = collectImportedSymbolTypes(session.ast!, ctx);
    const declarations = collectImportedTypeDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(source, declarations, symbolTypes);

    // `pkg.helper` should resolve to a function type (not unknown)
    const hover = richSession.analysis?.getHoverAt(1, 5);
    expect(hover?.contents).not.toContain("unknown");
    expect(hover?.contents).toContain("Result");
  });
});
