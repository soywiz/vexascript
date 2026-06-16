import { describe, expect, it, join, mkdir, mkdtemp, tmpdir, writeFile } from "../test/expect";
import { getNodeModuleTypings, findNodeModuleMemberLocation } from "./nodeModulesTypings";
import { collectImportedTypeDeclarations, collectImportedSymbolTypes, collectAllImportedDeclarations } from "./importedDeclarations";
import { createAnalysisSession } from "./analysisSession";
import dedent from "compiler/utils/dedent";
import { namedType, typeToString } from "compiler/analysis/types";

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
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const importerPath = join(root, "main.vx");
    const typings = await getNodeModuleTypings(importerPath, "pkg");

    expect(typings).not.toBeNull();
    expect(typings?.defaultExportName).toBe("pkg");
    expect(typings?.declarations.length).toBeGreaterThan(0);
  });

  it("returns null for unknown packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const importerPath = join(root, "main.vx");
    const typings = await getNodeModuleTypings(importerPath, "nonexistent-pkg");
    expect(typings).toBeNull();
  });

  it("walks up directory tree to find node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);
    const subDir = join(root, "src", "sub");
    await mkdir(subDir, { recursive: true });
    const importerPath = join(subDir, "main.vx");

    const typings = await getNodeModuleTypings(importerPath, "pkg");
    expect(typings).not.toBeNull();
    expect(typings?.defaultExportName).toBe("pkg");
  });

  it("collectImportedTypeDeclarations loads node_modules declarations for default import", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const mainPath = join(root, "main.vx");
    const source = `import pkg from "pkg"\npkg.helper()\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const declarations = await collectImportedTypeDeclarations(session.ast!, {
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
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const mainPath = join(root, "main.vx");
    const source = `import pkg from "pkg"\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const symbolTypes = await collectImportedSymbolTypes(session.ast!, {
      uri: `file://${mainPath}`,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect(symbolTypes.get("pkg")).toEqual(namedType("pkg"));
  });

  it("default import from node_modules gets named type instead of unknown in analysis", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const mainPath = join(root, "main.vx");
    const source = `import pkg from "pkg"\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const symbolTypes = await collectImportedSymbolTypes(session.ast!, ctx);
    const declarations = await collectImportedTypeDeclarations(session.ast!, ctx);

    const richSession = createAnalysisSession(source, declarations, symbolTypes);

    const symbol = richSession.analysis?.getTopLevelSymbolType("pkg");
    expect(symbol?.kind).toBe("named");
    expect((symbol as { name?: string })?.name).toBe("pkg");
  });


  it("assigns callable type to default imports from default function node_modules typings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "renderer", dedent`
      export default function render(value: unknown): string;
      export function helper(): string;
    `);

    const mainPath = join(root, "main.vx");
    const source = `import render from "renderer"\nconst html = render("page")\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const symbolTypes = await collectImportedSymbolTypes(session.ast!, ctx);
    const declarations = await collectImportedTypeDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(source, declarations, symbolTypes);

    expect(symbolTypes.get("render")?.kind).toBe("function");
    expect(typeToString(symbolTypes.get("render")!)).toBe("(value: unknown) => string");
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).not.toContain("Type 'renderer' is not callable");
  });

  it("preserves declared parameter and return types for generic default function node_modules typings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "renderer", dedent`
      import { VNode } from 'preact';
      export default function renderToString<P = {}>(vnode: VNode<P>, context?: any): string;
    `);

    const mainPath = join(root, "main.vx");
    const source = `import render from "renderer"\nrender()\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const symbolTypes = await collectImportedSymbolTypes(session.ast!, ctx);

    expect(typeToString(symbolTypes.get("render")!)).toBe("<P>(vnode: VNode<P>, context: any) => string");
  });

  it("assigns callable generic named imports from package exports subpath typings such as preact/hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "preact");
    await mkdir(join(pkgDir, "hooks", "src"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "preact",
        types: "./src/index.d.ts",
        exports: {
          ".": {
            types: "./src/index.d.ts"
          },
          "./hooks": {
            types: "./hooks/src/index.d.ts"
          }
        }
      }),
      "utf8"
    );
    await mkdir(join(pkgDir, "src"), { recursive: true });
    await writeFile(join(pkgDir, "src", "index.d.ts"), "export function render(vnode: unknown, parent: unknown): void;\n", "utf8");
    await writeFile(
      join(pkgDir, "hooks", "src", "index.d.ts"),
      dedent`
        export type Dispatch<A> = (value: A) => void;
        export type StateUpdater<S> = S | ((prevState: S) => S);
        export function useState<S>(initialState: S | (() => S)): [S, Dispatch<StateUpdater<S>>];
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { render } from "preact"
      import { useState } from "preact/hooks"

      const [count, setCount] = useState(0)
      setCount(count + 1)
      render(count, count)
    `;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(
      source,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );

    expect(typeToString(collected.importedSymbolTypes.get("useState")!)).toBe("<S>(initialState: S | () => S) => [S, Dispatch<StateUpdater<S>>]");
    expect(typeToString(collected.importedSymbolTypes.get("render")!)).toBe("(vnode: unknown, parent: unknown) => void");
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("findNodeModuleMemberLocation finds a member inside a namespace", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const importerPath = join(root, "main.vx");

    const result = await findNodeModuleMemberLocation(importerPath, "pkg", "pkg", "helper");
    expect(result).not.toBeNull();
    expect(result?.typingsPath).toContain("index.d.ts");
    expect(result?.range.start.line).toBeGreaterThanOrEqual(0);
  });

  it("findNodeModuleMemberLocation returns null for non-existent member", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const importerPath = join(root, "main.vx");
    const result = await findNodeModuleMemberLocation(importerPath, "pkg", "pkg", "nonExistent");
    expect(result).toBeNull();
  });

  it("resolves namespace members from node_modules typings for member access hover", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const mainPath = join(root, "main.vx");
    const source = `import pkg from "pkg"\npkg.helper()\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const symbolTypes = await collectImportedSymbolTypes(session.ast!, ctx);
    const declarations = await collectImportedTypeDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(source, declarations, symbolTypes);

    // `pkg.helper` should resolve to a function type (not unknown)
    const hover = richSession.analysis?.getHoverAt(1, 5);
    expect(hover?.contents).not.toContain("unknown");
    expect(hover?.contents).toContain("Result");
  });

  it("collectAllImportedDeclarations produces the same declarations and symbol types as calling both functions separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const mainPath = join(root, "main.vx");
    const source = `import pkg from "pkg"\npkg.helper()\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };

    const [combined, separateDeclarations, separateSymbolTypes] = await Promise.all([
      collectAllImportedDeclarations(session.ast!, ctx),
      collectImportedTypeDeclarations(session.ast!, ctx),
      collectImportedSymbolTypes(session.ast!, ctx)
    ]);

    expect(combined.externalDeclarations.length).toBe(separateDeclarations.length);
    expect(combined.importedSymbolTypes.size).toBe(separateSymbolTypes.size);
    for (const [key, value] of separateSymbolTypes) {
      expect(typeToString(combined.importedSymbolTypes.get(key)!)).toBe(typeToString(value));
    }
  });

  it("collectAllImportedDeclarations returns empty results for unknown file URI", async () => {
    const session = createAnalysisSession(`import pkg from "pkg"\n`);
    const result = await collectAllImportedDeclarations(session.ast!, {
      sourceRoots: [],
      getSessionForFilePath: () => null
    });
    expect(result.externalDeclarations).toEqual([]);
    expect(result.importedSymbolTypes.size).toBe(0);
  });
});
