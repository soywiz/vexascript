import { describe, expect, it, join, mkdir, mkdtemp, tmpdir, writeFile } from "../test/expect";
import {
  clearNodeModuleTypingsCache,
  getNodeModuleTypings,
  getNodeModuleTypingsForImportNames,
  findNodeModuleExportLocation,
  findNodeModuleMemberLocation
} from "./nodeModulesTypings";
import { collectImportedTypeDeclarations, collectImportedSymbolTypes, collectAllImportedDeclarations } from "./importedDeclarations";
import { createAnalysisSession } from "./analysisSession";
import dedent from "compiler/utils/dedent";
import { typeToString } from "compiler/analysis/types";
import type { Identifier, Statement, VarStatement } from "compiler/ast/ast";
import { sourceWithCursor } from "../test/sourceWithCursor";

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

  it("clears cached node_modules typings when requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const dtsPath = await makePackageWithTypings(root, "pkg", `export function oldVersion(): void;\n`);
    const importerPath = join(root, "main.vx");

    const first = await getNodeModuleTypings(importerPath, "pkg");
    expect(first?.declarations.some((statement) =>
      statement.kind === "ExportStatement"
      && (statement as { declaration?: { kind?: string; name?: { name?: string } } }).declaration?.kind === "FunctionStatement"
      && (statement as { declaration?: { name?: { name?: string } } }).declaration?.name?.name === "oldVersion"
    )).toBe(true);

    await writeFile(dtsPath, `export function newVersion(): void;\n`, "utf8");
    clearNodeModuleTypingsCache();

    const second = await getNodeModuleTypings(importerPath, "pkg");
    expect(second?.declarations.some((statement) =>
      statement.kind === "ExportStatement"
      && (statement as { declaration?: { kind?: string; name?: { name?: string } } }).declaration?.kind === "FunctionStatement"
      && (statement as { declaration?: { name?: { name?: string } } }).declaration?.name?.name === "newVersion"
    )).toBe(true);
  });

  it("selectively follows only the needed export-star branches for imported names", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pkg");
    await mkdir(join(pkgDir, "feature"), { recursive: true });
    await mkdir(join(pkgDir, "unused"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", typings: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), `export * from "./feature";\nexport * from "./unused";\n`, "utf8");
    await writeFile(join(pkgDir, "feature", "index.d.ts"), `export interface Needed { value: string; }\n`, "utf8");
    await writeFile(join(pkgDir, "unused", "index.d.ts"), `export interface Unused { ignored: number; }\n`, "utf8");

    const typings = await getNodeModuleTypingsForImportNames(join(root, "main.vx"), "pkg", new Set(["Needed"]));

    expect(typings?.declarations.some((statement) =>
      statement.kind === "ExportStatement"
      && (statement as { declaration?: { kind?: string; name?: { name?: string } } }).declaration?.kind === "InterfaceStatement"
      && (statement as { declaration?: { name?: { name?: string } } }).declaration?.name?.name === "Needed"
    )).toBe(true);
    expect(typings?.declarations.some((statement) =>
      statement.kind === "ExportStatement"
      && (statement as { declaration?: { name?: { name?: string } } }).declaration?.name?.name === "Unused"
    )).toBe(false);
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

  it("collectImportedSymbolTypes assigns callable type to default imports backed by export-equals functions", async () => {
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

    expect(typeToString(symbolTypes.get("pkg")!)).toBe("(x: string) => pkg.Result & { Result: Result, helper: () => Result }");
  });

  it("default import from node_modules gets callable type instead of unknown in analysis", async () => {
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
    expect(typeToString(symbol!)).toBe("(x: string) => pkg.Result & { Result: Result, helper: () => Result }");
  });

  it("accepts calling default imports backed by export-equals function typings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const mainPath = join(root, "main.vx");
    const source = `import pkg from "pkg"\nconst result = pkg("hello")\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const symbolTypes = await collectImportedSymbolTypes(session.ast!, ctx);
    const declarations = await collectImportedTypeDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(source, declarations, symbolTypes);

    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).not.toContain("Type 'pkg' is not callable");
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

  it("resolves node_modules import types from package declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "renderer", dedent`
      export interface FormatterOptions {
        trim?: boolean;
      }
      export const defaultOptions: import("renderer").FormatterOptions;
    `);

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { defaultOptions } from "renderer"
    `;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const symbolTypes = await collectImportedSymbolTypes(session.ast!, ctx);

    expect(typeToString(symbolTypes.get("defaultOptions")!)).toBe("FormatterOptions");
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

  it("preserves node_modules named import overloads so calls can select the matching signature", async () => {
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
    await writeFile(join(pkgDir, "src", "index.d.ts"), "export {};\n", "utf8");
    await writeFile(
      join(pkgDir, "hooks", "src", "index.d.ts"),
      dedent`
        export type Dispatch<A> = (value: A) => void;
        export type StateUpdater<S> = S | ((prevState: S) => S);
        export function useState<S>(initialState: S | (() => S)): [S, Dispatch<StateUpdater<S>>];
        export function useState<S = undefined>(): [S | undefined, Dispatch<StateUpdater<S | undefined>>];
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { useState } from "preact/hooks"

      var count by useState(0)
      count++
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

    expect(collected.importedSymbolTypes.get("useState")?.kind).toBe("union");
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("resolves node_modules named imports exported through local export specifiers in sidecar d.ts files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), 'export { useThing } from "./useThing.js";\n', "utf8");
    await writeFile(
      join(pkgDir, "useThing.d.ts"),
      dedent`
        declare function useThing<T>(value: T): T;
        export { useThing };
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { useThing } from "pkg"

      val answer = useThing(42)
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

    expect(typeToString(collected.importedSymbolTypes.get("useThing")!)).toBe("<T>(value: T) => T");
    expect(collected.invalidImportedBindings.has("useThing")).toBe(false);
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("resolves node_modules named imports reexported from local namespace bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pkg");
    const libDir = join(pkgDir, "lib");
    await mkdir(libDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), 'export * from "./lib/index.d.ts";\n', "utf8");
    await writeFile(
      join(libDir, "index.d.ts"),
      dedent`
        import * as z from "./external";
        export { z };
      `,
      "utf8"
    );
    await writeFile(
      join(libDir, "external.d.ts"),
      dedent`
        export interface ZString {
          min(size: number): ZString;
        }

        export function string(): ZString;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { z } from "pkg"

      val schema = z.string().min(2)
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

    expect(typeToString(collected.importedSymbolTypes.get("z")!)).toContain("string");
    expect(collected.invalidImportedBindings.has("z")).toBe(false);
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("prefers sidecar declaration files over sibling javascript when following .js reexports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), 'export { useThing } from "./useThing.js";\n', "utf8");
    await writeFile(
      join(pkgDir, "useThing.d.ts"),
      dedent`
        declare function useThing<T>(value: T): T;
        export { useThing };
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "useThing.js"),
      dedent`
        function useThing(value) {
          return value;
        }

        export { useThing };
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { useThing } from "pkg"

      val answer = useThing(42)
    `;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);

    expect(typeToString(collected.importedSymbolTypes.get("useThing")!)).toBe("<T>(value: T) => T");
    expect(collected.invalidImportedBindings.has("useThing")).toBe(false);
  });

  it("resolves members from imported generic type aliases returned by node_modules functions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        interface QueryState<T> {
          data: T;
          isLoading: boolean;
        }

        type UseThingResult<T> = QueryState<T>;

        export function useThing<T = unknown>(): UseThingResult<T>;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { useThing } from "pkg"

      type Payload = { title: string }

      val result = useThing<Payload>()
      val title = result.data.title
      if (result.isLoading) {
      }
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

    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("resolves members from node_modules functions reexported through .js with sibling generic declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), 'export { useThing } from "./useThing.js";\n', "utf8");
    await writeFile(
      join(pkgDir, "useThing.d.ts"),
      dedent`
        interface QueryState<TData, TError> {
          data: TData | undefined;
          isLoading: boolean;
          error: TError | null;
        }

        type UseThingResult<TData, TError> = QueryState<TData, TError>;

        declare function useThing<TData = unknown, TError = Error>(): UseThingResult<TData, TError>;
        export { useThing };
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "useThing.js"),
      dedent`
        function useThing() {
          return { data: undefined, isLoading: false, error: null };
        }

        export { useThing };
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { useThing } from "pkg"

      type Payload = { title: string }

      val result = useThing<Payload, string>()
      if (result.isLoading) {
      }
      if (result.error) {
        val message = result.error
      }
      if (result.data) {
        val title = result.data.tit^^^le
      }
    `);
    await writeFile(mainPath, marked.source, "utf8");

    const session = createAnalysisSession(marked.source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(
      marked.source,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );

    expect(typeToString(collected.importedSymbolTypes.get("useThing")!)).toBe("<TData, TError>() => UseThingResult<TData, TError>");
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
    expect(richSession.analysis?.getHoverAt(marked.line, marked.character)?.contents).toContain("string");
  });

  it("preserves react-query-style imported generic option and result typing", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export class QueryClient {
        }

        export interface QueryFunctionContext<TQueryKey extends ReadonlyArray<unknown> = ReadonlyArray<unknown>> {
          queryKey: TQueryKey;
        }

        export interface UseQueryOptions<
          TData = unknown,
          TError = Error,
          TSelected = TData,
          TQueryKey extends ReadonlyArray<unknown> = ReadonlyArray<unknown>
        > {
          queryKey: TQueryKey;
          queryFn: (context: QueryFunctionContext<TQueryKey>) => Promise<TData> | TData;
          select?: (data: TData) => TSelected;
        }

        export interface UseQueryResult<TData = unknown, TError = Error> {
          data: TData | undefined;
          isLoading: boolean;
          error: TError | null;
        }

        export function useQuery<
          TData = unknown,
          TError = Error,
          TSelected = TData,
          TQueryKey extends ReadonlyArray<unknown> = ReadonlyArray<unknown>
        >(
          options: UseQueryOptions<TData, TError, TSelected, TQueryKey>,
          queryClient?: QueryClient
        ): UseQueryResult<TSelected, TError>;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { QueryClient, useQuery } from "pkg"

      type Payload = { title: string }
      val queryKey: ReadonlyArray<string> = ["roadmap"]

      val result = useQuery<Payload, string, string, ReadonlyArray<string>>({
        queryKey,
        queryFn: async (context) => {
          val first = String(context.queryKey[0])
          return { title: fir^^^st }
        },
        select: (data) => data.title
      })

      if (result.isLoading) {
      }
      if (result.error) {
        val message = result.error
      }
      val title = result.data
    `);
    await writeFile(mainPath, marked.source, "utf8");

    const session = createAnalysisSession(marked.source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(
      marked.source,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );

    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
    expect(richSession.analysis?.getHoverAt(marked.line, marked.character)?.contents).toContain("string");
  });

  it("infers react-query-style imported generic option and result typing without explicit type arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export class QueryClient {
        }

        export interface QueryFunctionContext<TQueryKey extends ReadonlyArray<unknown> = ReadonlyArray<unknown>> {
          queryKey: TQueryKey;
        }

        export interface UseQueryOptions<
          TData = unknown,
          TError = Error,
          TSelected = TData,
          TQueryKey extends ReadonlyArray<unknown> = ReadonlyArray<unknown>
        > {
          queryKey: TQueryKey;
          queryFn: (context: QueryFunctionContext<TQueryKey>) => Promise<TData> | TData;
          select?: (data: TData) => TSelected;
        }

        export interface UseQueryResult<TData = unknown, TError = Error> {
          data: TData | undefined;
          isLoading: boolean;
          error: TError | null;
        }

        export function useQuery<
          TData = unknown,
          TError = Error,
          TSelected = TData,
          TQueryKey extends ReadonlyArray<unknown> = ReadonlyArray<unknown>
        >(
          options: UseQueryOptions<TData, TError, TSelected, TQueryKey>,
          queryClient?: QueryClient
        ): UseQueryResult<TSelected, TError>;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { QueryClient, useQuery } from "pkg"

      val queryKey: ReadonlyArray<string> = ["roadmap"]
      val queryClient = QueryClient()

      val result = useQuery({
        queryKey,
        queryFn: async (context) => {
          val first = String(context.queryKey[0])
          return { title: first }
        },
        select: (data) => data.tit^^^le
      }, queryClient)

      if (result.data) {
        val title = result.data
      }
    `);
    await writeFile(mainPath, marked.source, "utf8");

    const session = createAnalysisSession(marked.source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(
      marked.source,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );

    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
    expect(richSession.analysis?.getHoverAt(marked.line, marked.character)?.contents).toContain("string");
  });

  it("infers imported generic result typing when a callback property uses a function type alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export type QueryKey = ReadonlyArray<unknown>;

        export type QueryFunctionContext<TQueryKey extends QueryKey = QueryKey> = {
          queryKey: TQueryKey;
        };

        export type QueryFunction<T = unknown, TQueryKey extends QueryKey = QueryKey> = (
          context: QueryFunctionContext<TQueryKey>
        ) => T | Promise<T>;

        export class QueryClient {
        }

        export interface UseQueryOptions<
          TQueryFnData = unknown,
          TError = Error,
          TData = TQueryFnData,
          TQueryKey extends QueryKey = QueryKey
        > {
          queryKey: TQueryKey;
          queryFn?: QueryFunction<TQueryFnData, TQueryKey>;
        }

        export interface UseQueryResult<TData = unknown, TError = Error> {
          data: TData | undefined;
          isLoading: boolean;
          error: TError | null;
        }

        export function useQuery<
          TQueryFnData = unknown,
          TError = Error,
          TData = TQueryFnData,
          TQueryKey extends QueryKey = QueryKey
        >(
          options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
          queryClient?: QueryClient
        ): UseQueryResult<TData, TError>;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { QueryClient, useQuery } from "pkg"

      val queryClient = QueryClient()
      val roadmapQueryKey: ReadonlyArray<string> = ["react-sample", "roadmap"]

      val result = useQuery({
        queryKey: roadmapQueryKey,
        queryFn: async (context) => {
          return {
            headline: String(context.queryKey[0]),
            checks: ["ready"]
          }
        }
      }, queryClient)

      if (result.data) {
        val title = result.data.head^^^line
      }
    `);
    await writeFile(mainPath, marked.source, "utf8");

    const session = createAnalysisSession(marked.source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(
      marked.source,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );

    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
    expect(richSession.analysis?.getHoverAt(marked.line, marked.character)?.contents).toContain("string");
  });

  it("accepts node_modules hook callbacks and dependency arrays that use local sibling aliases", async () => {
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
        type Inputs = ReadonlyArray<unknown>;
        type EffectCallback = () => void | (() => void);
        export function useEffect(effect: EffectCallback, inputs?: Inputs): void;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { useEffect } from "preact/hooks"

      fun App() {
        useEffect(() => {
        }, [])
      }
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

    expect(typeToString(collected.importedSymbolTypes.get("useEffect")!)).toBe("(effect: EffectCallback, inputs: Inputs) => void");
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("accepts node_modules hook callbacks whose cleanup returns another function type", async () => {
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
    await writeFile(join(pkgDir, "src", "index.d.ts"), "export {};\n", "utf8");
    await writeFile(
      join(pkgDir, "hooks", "src", "index.d.ts"),
      dedent`
        type Inputs = ReadonlyArray<unknown>;
        type EffectCallback = () => void | (() => void);
        export function useEffect(effect: EffectCallback, inputs?: Inputs): void;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { useEffect } from "preact/hooks"

      fun App() {
        useEffect(() => {
          return () => {}
        }, [])
      }
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

    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("follows relative export-star reexports when collecting node_modules typings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "preact");
    await mkdir(join(pkgDir, "src"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "preact", types: "./src/index.d.ts" }),
      "utf8"
    );
    await writeFile(join(pkgDir, "src", "index.d.ts"), 'export * from "./dom";\n', "utf8");
    await writeFile(
      join(pkgDir, "src", "dom.d.ts"),
      dedent`
        export interface HTMLAttributes<T> {
          style?: string;
        }

        export interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
          value?: string;
        }
      `,
      "utf8"
    );

    const typings = await getNodeModuleTypings(join(root, "main.vx"), "preact");

    expect(typings?.declarations.some((statement) =>
      statement.kind === "ExportStatement"
      && (statement as { declaration?: { kind?: string; name?: { name?: string } } }).declaration?.kind === "InterfaceStatement"
      && (statement as { declaration?: { name?: { name?: string } } }).declaration?.name?.name === "InputHTMLAttributes"
    )).toBe(true);
  });

  it("resolves named type imports from node_modules packages that reexport through export-star", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "preact");
    await mkdir(join(pkgDir, "src"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "preact", types: "./src/index.d.ts" }),
      "utf8"
    );
    await writeFile(join(pkgDir, "src", "index.d.ts"), 'export * from "./dom";\n', "utf8");
    await writeFile(
      join(pkgDir, "src", "dom.d.ts"),
      dedent`
        export interface HTMLAttributes<T> {
          style?: string;
        }

        export interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
          value?: string;
        }
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { InputHTMLAttributes } from "preact"

      interface HTMLInputElement {
      }

      interface InputProperties extends InputHTMLAttributes<HTMLInputElement> {
        mySpecialProp: any
      }

      const Input = (props: InputProperties) => <input {...props} />
      const html = <Input mySpecialProp="" style="" />
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

    expect(collected.invalidImportedBindings.has("InputHTMLAttributes")).toBe(false);
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).not.toContain("No parameter named 'style'");
    expect(richSession.analysis?.getUnusedImportIdentifiers().map((identifier) => identifier.name)).toEqual([]);
  });

  it("follows bare export-star reexports when collecting node_modules typings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pixi.js");
    const depDir = join(root, "node_modules", "@pixi", "text");
    await mkdir(join(pkgDir, "lib"), { recursive: true });
    await mkdir(join(depDir, "lib"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pixi.js", types: "./lib/index.d.ts" }),
      "utf8"
    );
    await writeFile(join(pkgDir, "lib", "index.d.ts"), 'export * from "@pixi/text";\n', "utf8");
    await writeFile(
      join(depDir, "package.json"),
      JSON.stringify({ name: "@pixi/text", types: "./lib/index.d.ts" }),
      "utf8"
    );
    await writeFile(join(depDir, "lib", "index.d.ts"), "export declare class TextStyle {}\n", "utf8");

    const typings = await getNodeModuleTypings(join(root, "main.vx"), "pixi.js");

    expect(typings?.declarations.some((statement) =>
      statement.kind === "ExportStatement"
      && (statement as { declaration?: { kind?: string; name?: { name?: string } } }).declaration?.kind === "ClassStatement"
      && (statement as { declaration?: { name?: { name?: string } } }).declaration?.name?.name === "TextStyle"
    )).toBe(true);
  });

  it("follows bare renamed reexports when collecting node_modules typings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pkg");
    const depDir = join(root, "node_modules", "dep");
    await mkdir(join(pkgDir, "lib"), { recursive: true });
    await mkdir(join(depDir, "lib"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", types: "./lib/index.d.ts" }),
      "utf8"
    );
    await writeFile(join(pkgDir, "lib", "index.d.ts"), 'export { b as QueryClient } from "dep";\n', "utf8");
    await writeFile(
      join(depDir, "package.json"),
      JSON.stringify({ name: "dep", types: "./lib/index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(depDir, "lib", "index.d.ts"),
      'declare class QueryClient {}\nexport { QueryClient as b };\n',
      "utf8"
    );

    const typings = await getNodeModuleTypings(join(root, "main.vx"), "pkg");

    expect(typings?.declarations.some((statement) =>
      statement.kind === "ExportStatement"
      && (statement as { declaration?: { kind?: string; name?: { name?: string } } }).declaration?.kind === "ClassStatement"
      && (statement as { declaration?: { name?: { name?: string } } }).declaration?.name?.name === "QueryClient"
    )).toBe(true);
  });

  it("only injects relevant node_modules externals while keeping helper types needed by imported members", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export interface Helper {
          label: string;
        }

        export declare class Foo {
          value: Helper;
        }

        export declare function keep(): Foo;
        export declare function drop(): string;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { keep } from "pkg"

      const value = keep().value
      console.log(value.label)
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

    const externalNames = collected.externalDeclarations.map((statement) => {
      const candidate = statement as {
        name?: { name?: string };
        declaration?: { name?: { name?: string } };
      };
      return candidate.name?.name ?? candidate.declaration?.name?.name ?? statement.kind;
    });

    expect(externalNames).toContain("Helper");
    expect(externalNames).toContain("Foo");
    expect(externalNames).not.toContain("drop");
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("follows triple-slash references and support imports when collecting node_modules typings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pixi-like");
    await mkdir(join(pkgDir, "lib"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pixi-like", types: "./lib/index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "global.d.ts"),
      dedent`
        declare namespace GlobalMixins {
          interface Application {
            ticker: {
              add(callback: () => void): void;
            };
          }
        }
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "lib", "plugin.d.ts"),
      dedent`
        declare namespace GlobalMixins {
          interface Application {
            pluginReady: boolean;
          }
        }
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "lib", "Application.d.ts"),
      dedent`
        export interface Application extends GlobalMixins.Application {
        }

        export declare class Application {
        }
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "lib", "index.d.ts"),
      dedent`
        /// <reference path="../global.d.ts" />
        import "./plugin";
        export * from "./Application";
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Application } from "pixi-like"

      const app = new Application()
      app.ticker.add(() => {})
      console.log(app.pluginReady)
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

    expect(richSession.analysis?.getIssues().map((issue) => issue.message) ?? []).toEqual([]);
  });

  it("preserves imported support declarations needed by node_modules option types", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pixi-like");
    await mkdir(join(pkgDir, "rendering"), { recursive: true });
    await mkdir(join(pkgDir, "app"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pixi-like", types: "./app/Application.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "rendering", "RendererOptions.d.ts"),
      dedent`
        export interface RendererOptions {
          width?: number;
          height?: number;
          resolution?: number;
          antialias?: boolean;
        }
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "rendering", "autoDetectRenderer.d.ts"),
      dedent`
        import type { RendererOptions } from "./RendererOptions";

        export interface AutoDetectOptions extends RendererOptions {
          preference?: "webgl" | "webgpu";
        }
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "app", "Application.d.ts"),
      dedent`
        import type { AutoDetectOptions } from "../rendering/autoDetectRenderer";

        export interface ApplicationOptions extends AutoDetectOptions {
        }

        export declare class Application {
          init(options: Partial<ApplicationOptions>): Promise<void>;
        }
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Application } from "pixi-like"

      val app = Application()
      await app.init({
        width: 480,
        height: 320,
        resolution: 1,
        antialias: true,
      })
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

    expect(collected.externalDeclarations.some((statement) => statement.kind === "ImportStatement")).toBe(true);
    expect(richSession.analysis?.getIssues().map((issue) => issue.message) ?? []).toEqual([]);
  });

  it("includes typeof-referenced support vars needed by node_modules renderer option extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pixi-like");
    await mkdir(join(pkgDir, "rendering"), { recursive: true });
    await mkdir(join(pkgDir, "app"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pixi-like", types: "./app/Application.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "rendering", "SharedSystems.d.ts"),
      dedent`
        export interface ViewSystemOptions {
          width?: number;
          height?: number;
          antialias?: boolean;
          resolution?: number;
        }

        export interface TickerOptions {
          autoStart?: boolean;
        }

        export declare class ViewSystem {
          static defaultOptions: ViewSystemOptions;
        }

        export declare class TickerSystem {
          static defaultOptions: TickerOptions;
        }

        export declare const SharedSystems: (typeof ViewSystem | typeof TickerSystem)[];
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "rendering", "RendererOptions.d.ts"),
      dedent`
        import type { SharedSystems } from "./SharedSystems";

        export type ExtractRendererOptions<T extends any[]> = T extends any ? never : never;

        export interface SharedRendererOptions extends ExtractRendererOptions<typeof SharedSystems> {
        }

        export interface RendererOptions extends SharedRendererOptions {
          preference?: "webgl" | "webgpu";
        }
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "rendering", "autoDetectRenderer.d.ts"),
      dedent`
        import type { RendererOptions } from "./RendererOptions";

        export interface AutoDetectOptions extends RendererOptions {
        }
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "app", "Application.d.ts"),
      dedent`
        import type { AutoDetectOptions } from "../rendering/autoDetectRenderer";

        export interface ApplicationOptions extends AutoDetectOptions {
        }

        export declare class Application {
          init(options: Partial<ApplicationOptions>): Promise<void>;
        }
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Application } from "pixi-like"

      val app = Application()
      await app.init({
        width: 480,
        height: 320,
        resolution: 1,
        antialias: true,
        autoStart: true,
      })
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

    expect(
      collected.externalDeclarations.some((statement) => {
        const declaration = statement.kind === "ExportStatement"
          ? (statement as { declaration?: Statement }).declaration
          : statement;
        return declaration?.kind === "VarStatement"
          && (declaration as VarStatement).name.kind === "Identifier"
          && ((declaration as VarStatement).name as Identifier).name === "SharedSystems";
      })
    ).toBe(true);
    expect(richSession.analysis?.getIssues().map((issue) => issue.message) ?? []).toEqual([]);
  });

  it("preserves node_modules type aliases that depend on sibling aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "preact");
    await mkdir(join(pkgDir, "src"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "preact", types: "./src/index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "src", "index.d.ts"),
      dedent`
        export type ComponentChild = string | number;
        export type ComponentChildren = ComponentChild[] | ComponentChild;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { ComponentChildren } from "preact"

      fun MyButton({ children: ComponentChildren }) {
        return children
      }
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

    expect(typeToString(collected.importedSymbolTypes.get("ComponentChildren")!)).toBe("ComponentChildren");
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).not.toContain(
      "Unknown type 'ComponentChild'. Expected builtin type (int, number, string, boolean, bigint, long, void) or declared class/interface/type parameter"
    );
  });

  it("follows export-star reexports that point at .js specifiers to declaration siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "three-like");
    await mkdir(join(pkgDir, "src"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "three-like", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      'export * from "./src/ThreeLike.js";\n',
      "utf8"
    );
    await writeFile(
      join(pkgDir, "src", "ThreeLike.d.ts"),
      dedent`
        export class Vector3 {
          set(x: number, y: number, z: number): this;
        }

        export class Object3D {
          readonly position: Vector3;
          lookAt(target: Vector3): void;
        }

        export class PerspectiveCamera extends Object3D {
        }
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import * as THREE from "three-like"

      val camera = new THREE.PerspectiveCamera()
      camera.position.set(1, 2, 3)
      camera.lookAt(new THREE.Vector3())
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

    expect(richSession.analysis?.getIssues().map((issue) => issue.message) ?? []).toEqual([]);
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

  it("findNodeModuleMemberLocation follows export-star reexports to the original declaration file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "preact");

    await mkdir(join(pkgDir, "src"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "preact",
        types: "./src/index.d.ts"
      }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "src", "index.d.ts"),
      'export * from "./dom";\n',
      "utf8"
    );
    await writeFile(
      join(pkgDir, "src", "dom.d.ts"),
      dedent`
        export declare class Widget {
          drawRoundedRect(x: number, y: number, width: number, height: number, radius: number): this;
        }
      `,
      "utf8"
    );

    const importerPath = join(root, "main.vx");
    const location = await findNodeModuleMemberLocation(importerPath, "preact", "Widget", "drawRoundedRect");

    expect(location).not.toBeNull();
    expect(location?.typingsPath).toContain("src/dom.d.ts");
    expect(location?.range.start.line).toBe(1);
  });

  it("findNodeModuleMemberLocation follows qualified namespace mixin inheritance", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pixi-like");

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pixi-like",
        types: "./index.d.ts"
      }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export interface ChildrenHelperMixin {
          addChildAt(index: number): void;
        }

        declare global {
          namespace PixiMixins {
            interface Container extends ChildrenHelperMixin {}
          }
        }

        export interface Container extends PixiMixins.Container {}

        export declare class Container {
        }

        export { };
      `,
      "utf8"
    );

    const importerPath = join(root, "main.vx");
    const location = await findNodeModuleMemberLocation(importerPath, "pixi-like", "Container", "addChildAt");

    expect(location).not.toBeNull();
    expect(location?.typingsPath).toContain("index.d.ts");
    expect(location?.range.start.line).toBe(1);
  });

  it("findNodeModuleExportLocation finds a named export inside package exports subpath typings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "preact");
    const hooksDir = join(pkgDir, "hooks");

    await mkdir(join(hooksDir, "src"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "preact",
        types: "src/index.d.ts",
        exports: {
          ".": { types: "./src/index.d.ts" },
          "./hooks": { types: "./hooks/src/index.d.ts" }
        }
      }),
      "utf8"
    );
    await mkdir(join(pkgDir, "src"), { recursive: true });
    await writeFile(join(pkgDir, "src", "index.d.ts"), "export function render(vnode: unknown, parent: unknown): void;\n", "utf8");
    const hooksSource = dedent`
      export type Dispatch<A> = (value: A) => void;
      export type StateUpdater<S> = S | ((prevState: S) => S);
      export function useState<S>(initialState: S | (() => S)): [S, Dispatch<StateUpdater<S>>];
    `;
    await writeFile(join(hooksDir, "src", "index.d.ts"), hooksSource, "utf8");

    const importerPath = join(root, "main.vx");
    const location = await findNodeModuleExportLocation(importerPath, "preact/hooks", "useState");

    expect(location).not.toBeNull();
    expect(location?.typingsPath).toContain("hooks/src/index.d.ts");
    expect(location?.range.start.line).toBe(2);
  });

  it("findNodeModuleExportLocation follows export-star reexports to the original declaration file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "preact");

    await mkdir(join(pkgDir, "src"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "preact",
        types: "./src/index.d.ts"
      }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "src", "index.d.ts"),
      'export * from "./dom";\n',
      "utf8"
    );
    await writeFile(
      join(pkgDir, "src", "dom.d.ts"),
      dedent`
        export interface HTMLAttributes<T> {
          style?: string;
        }

        export interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
          value?: string;
        }
      `,
      "utf8"
    );

    const importerPath = join(root, "main.vx");
    const location = await findNodeModuleExportLocation(importerPath, "preact", "InputHTMLAttributes");

    expect(location).not.toBeNull();
    expect(location?.typingsPath).toContain("src/dom.d.ts");
    expect(location?.range.start.line).toBe(4);
  });

  it("preserves imported interface type parameters when export-import aliases share the same name", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "preact");

    await mkdir(join(pkgDir, "src"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "preact",
        types: "./src/index.d.ts"
      }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "src", "index.d.ts"),
      dedent`
        import { JSXInternal } from "./jsx";
        export * from "./dom";
        export import InputHTMLAttributes = JSXInternal.InputHTMLAttributes;
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "src", "dom.d.ts"),
      dedent`
        export interface HTMLAttributes<T> {
          style?: string;
        }

        export interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
          value?: string;
        }
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "src", "jsx.d.ts"),
      dedent`
        export namespace JSXInternal {
          export interface InputHTMLAttributes<T> {
          }
        }
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { InputHTMLAttributes } from "preact"

      interface HTMLInputElement {
      }

      interface InputProperties extends InputHTMLAttributes<HTMLInputElement> {
        mySpecialProp: any
      }
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

    const messages = richSession.analysis?.getIssues().map((issue) => issue.message) ?? [];
    expect(messages).not.toContain("Expected at most 0 type argument(s), but got 1");
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

  it("treats optional imported type annotations as real type references for hover and unused-import tracking", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "preact",
      dedent`
        export type ComponentChild = string | number;
        export type ComponentChildren = ComponentChild[] | ComponentChild;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { ComponentChildren } from "preact"

      fun MyButton({ children: ComponentChildren? }) {
        return children
      }
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

    const hoverOffset = source.indexOf("ComponentChildren");
    const prefix = source.slice(0, hoverOffset);
    const hoverLine = prefix.split("\n").length - 1;
    const hoverCharacter = hoverOffset - prefix.lastIndexOf("\n") - 1;
    const hover = richSession.analysis?.getHoverAt(hoverLine, hoverCharacter + 2);

    expect(hover?.contents).toContain("ComponentChildren");
    expect(richSession.analysis?.getUnusedImportIdentifiers().map((identifier) => identifier.name)).not.toContain(
      "ComponentChildren"
    );
  });

  it("specializes imported generic class methods that use mapped utility types", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "preact-like",
      dedent`
        export abstract class Component<S> {
          state: Readonly<S>;
          setState<K extends keyof S>(state: Pick<S, K> | Partial<S> | null, callback?: () => void): void;
        }
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Component } from "preact-like"

      class Clock extends Component<{ time: number }> {
        state: { time: number }

        componentDidMount() {
          this.setState({ time: Date.now() })
        }
      }
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("accepts assigning concrete values into imported Readonly and Partial state shapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "preact-like",
      dedent`
        export interface Component<P = {}, S = {}> {
          state: Readonly<S>;
        }

        export abstract class Component<P, S> {
          constructor(props?: P, context?: any);
          state: Readonly<S>;
          setState<K extends keyof S>(
            state:
              | ((prevState: Readonly<S>, props: Readonly<P>) => Pick<S, K> | Partial<S> | null)
              | (Pick<S, K> | Partial<S> | null),
            callback?: () => void
          ): void;
        }
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Component } from "preact-like"

      class Clock extends Component<any, { time: number }> {
        state: { time: number }
        timer: number? = undefined

        constructor() {
          super()
          this.state = { time: Date.now() }
        }

        componentDidMount() {
          this.setState({ time: Date.now() })
        }
      }
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("treats imported Partial utility properties as optional for object literal arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "partial-pkg",
      dedent`
        export interface MaterialOptions {
          color: string;
          roughness: number;
          metalness: number;
        }

        export function makeMaterial(options: Partial<MaterialOptions>): void;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { makeMaterial } from "partial-pkg"

      makeMaterial({
        color: "#fff",
        roughness: 0.3
      })
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("resolves broader built-in utility aliases from imported declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "utility-box",
      dedent`
        export type PublicState = Exclude<"idle" | "loading" | "done", "idle">;
        export type StableState = Extract<"idle" | "loading" | "done", "done" | "error">;
        export type UserName = NonNullable<string | null | undefined>;
        export type Labels = Record<"title" | "subtitle", string>;
        export type ThemeConfig = Readonly<{ theme: string; retries: number }>;
        export type Settled = Awaited<Promise<Promise<string>>>;
        export type UseFlag = (name: string, count: number) => boolean;
        export type UseFlagReturn = ReturnType<UseFlag>;
        export type UseFlagParameters = Parameters<UseFlag>;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import type {
        PublicState,
        StableState,
        UserName,
        Labels,
        ThemeConfig,
        Settled,
        UseFlagReturn,
        UseFlagParameters
      } from "utility-box"

      let publicState: PublicState = "loading"
      let stableState: StableState = "done"
      let userName: UserName = "Ada"
      let labels: Labels = { title: "Hello", subtitle: "World" }
      let config: ThemeConfig = { theme: "light", retries: 3 }
      let settled: Settled = "ok"
      let fnReturn: UseFlagReturn = true
      let fnParameters: UseFlagParameters = ["Ada", 1]
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("resolves constructor and this-parameter utility aliases from imported declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "constructor-box",
      dedent`
        export class User {
          constructor(name: string, age: number);
        }
        export type UserCtorArgs = ConstructorParameters<User>;
        export type UserInstance = InstanceType<User>;
        export type Method = (this: User, value: string) => boolean;
        export type Receiver = ThisParameterType<Method>;
        export type BoundMethod = OmitThisParameter<Method>;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { User } from "constructor-box"
      import type { UserCtorArgs, UserInstance, Receiver, BoundMethod } from "constructor-box"

      let ctorArgs: UserCtorArgs = ["Ada", 1]
      let user: UserInstance = new User("Ada", 1)
      let receiver: Receiver = user
      let bound: BoundMethod = (value: string) => true
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("resolves identity and string-transform utility aliases from imported declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "string-box",
      dedent`
        export type Literal = "hello world";
        export type Alias = NoInfer<Literal>;
        export type Context = ThisType<{ name: string }>;
        export type Loud = Uppercase<Literal>;
        export type Quiet = Lowercase<"HELLO WORLD">;
        export type Title = Capitalize<"hello">;
        export type Camel = Uncapitalize<"Hello">;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import type { Alias, Context, Loud, Quiet, Title, Camel } from "string-box"

      let alias: Alias = "hello world"
      let context: Context = { name: "Ada" }
      let loud: Loud = "HELLO WORLD"
      let quiet: Quiet = "hello world"
      let title: Title = "Hello"
      let camel: Camel = "hello"
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("resolves template literal types from imported declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "template-box",
      dedent`
        export type Prefix = "pre";
        export type Event = "click" | "focus";
        export type EventName = \`\${Prefix}:\${Event}\`;
        export type DynamicEventName = \`\${string}:\${Event}\`;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import type { EventName, DynamicEventName } from "template-box"

      let click: EventName = "pre:click"
      let focus: EventName = "pre:focus"
      let dynamic: DynamicEventName = "anything:click"
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("resolves readonly array and tuple shorthand from imported declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "readonly-box",
      dedent`
        export type Names = readonly string[];
        export type Pair = readonly [name: string, count: number];
        export type First<T extends ReadonlyArray<unknown>> = T[number];
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import type { Names, Pair, First } from "readonly-box"

      let names: Names = ["Ada", "Grace"]
      let pair: Pair = ["Ada", 1]
      let arrayLike: ReadonlyArray<string> = names
      let firstName: First<Names> = "Ada"
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("treats imported readonly arrays and tuples as non-mutable targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "readonly-box",
      dedent`
        export type Names = readonly string[];
        export type Pair = readonly [name: string, count: number];
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import type { Names, Pair } from "readonly-box"

      let mutableNames: string[] = ["Ada"]
      let readonlyNames: Names = mutableNames
      let mutableFromReadonly: string[] = readonlyNames

      let readonlyPair: Pair = ["Ada", 1]
      readonlyNames[0] = "Grace"
      readonlyPair[1]++
    `;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(
      source,
      collected.externalDeclarations,
      collected.importedSymbolTypes
    );

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([
      "Type 'readonly string[]' is not assignable to type 'string[]'",
      "Cannot assign through readonly index access",
      "Cannot assign through readonly index access"
    ]);
  });

  it("treats imported Readonly and mapped readonly object properties as non-mutable targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "readonly-object-box",
      dedent`
        export type User = { id: number; name?: string };
        export type FrozenUser = Readonly<User>;
        export type Freeze<T> = { readonly [K in keyof T]: T[K] };
        export type FrozenViaMapped = Freeze<User>;
        export type MutableAgain = { -readonly [K in keyof FrozenViaMapped]-?: FrozenViaMapped[K] };
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import type { FrozenUser, FrozenViaMapped, MutableAgain } from "readonly-object-box"

      let frozenUser: FrozenUser = { id: 1, name: "Ada" }
      let frozenViaMapped: FrozenViaMapped = { id: 2 }
      let mutableAgain: MutableAgain = { id: 3, name: "Grace" }
      let exactUser: { id: int, name: string } = mutableAgain

      frozenUser.id = 2
      frozenViaMapped["id"] = 4
      mutableAgain.id = 5
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([
      "Cannot assign to readonly member 'id'",
      "Cannot assign to readonly member 'id'"
    ]);
  });

  it("resolves top-level conditional infer aliases from imported declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "infer-box",
      dedent`
        export type Element<T> = T extends (infer U)[] ? U : T;
        export type AwaitedValue<T> = T extends Promise<infer U> ? U : T;
        export type Result<T> = T extends (...args: any) => infer R ? R : never;
        export type Handler = (name: string, count: number) => boolean;
        export type ElementValue = Element<string[]>;
        export type AwaitedInt = AwaitedValue<Promise<number>>;
        export type HandlerResult = Result<Handler>;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import type { ElementValue, AwaitedInt, HandlerResult } from "infer-box"

      let element: ElementValue = "Ada"
      let awaitedValue: AwaitedInt = 1
      let result: HandlerResult = true
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("resolves constrained infer and nested conditional aliases from imported declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "conditional-box",
      dedent`
        export type Constrained<T> = T extends infer U extends string ? U : never;
        export type Recursive<T> = T extends string ? true : T extends number ? false : never;
        export type ConstrainedName = Constrained<"Ada">;
        export type RecursiveString = Recursive<string>;
        export type RecursiveNumber = Recursive<number>;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import type { ConstrainedName, RecursiveString, RecursiveNumber } from "conditional-box"

      let constrained: ConstrainedName = "Ada"
      let recursiveString: RecursiveString = true
      let recursiveNumber: RecursiveNumber = false
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("resolves mapped key remapping aliases from imported declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "mapped-remap-box",
      dedent`
        export interface Person {
          name: string;
          age: number;
        }
        export interface MaybePerson {
          name?: string;
        }
        export type Labels<T> = { [K in keyof T as \`label_\${K}\`]: T[K] };
        export type WithoutName<T> = { [K in keyof T as Exclude<K, "name">]: T[K] };
        export type Concrete<T> = { [K in keyof T as K]-?: T[K] };
        export type PersonLabels = Labels<Person>;
        export type PersonWithoutName = WithoutName<Person>;
        export type ConcreteMaybePerson = Concrete<MaybePerson>;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import type { PersonLabels, PersonWithoutName, ConcreteMaybePerson } from "mapped-remap-box"

      let labels: PersonLabels = { label_name: "Ada", label_age: 1 }
      let labelName: string = labels.label_name
      let onlyAge: PersonWithoutName = { age: 1 }
      let age: number = onlyAge.age
      let concrete: ConcreteMaybePerson = { name: "Ada" }
      let concreteName: string = concrete.name
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("resolves unique symbol, assertion signatures, and abstract constructor signatures from imported declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "ts-signature-box",
      dedent`
        export class User {
          constructor(name: string, age: number);
        }
        export type Token = unique symbol;
        export type AssertString = (value: unknown) => asserts value is string;
        export type UserCtorArgs = ConstructorParameters<abstract new (name: string, age: number) => User>;
        export type UserInstance = InstanceType<abstract new (name: string, age: number) => User>;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { User } from "ts-signature-box"
      import type { Token, AssertString, UserCtorArgs, UserInstance } from "ts-signature-box"

      let token: Token = Symbol.iterator
      let assertString: AssertString = (value: unknown) => {}
      let args: UserCtorArgs = ["Ada", 1]
      let user: UserInstance = new User("Ada", 1)
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("narrows values after imported assertion-signature calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "guard-box",
      dedent`
        export function assertString(value: unknown): asserts value is string;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { assertString } from "guard-box"

      let maybeName: unknown = "Ada"
      assertString(maybeName)
      let okName: string = maybeName
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("narrows nullable values after imported generic bare assertion-signature calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "guard-box",
      dedent`
        export function assertPresent<T>(value: T): asserts value;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { assertPresent } from "guard-box"

      let maybeHeadline: string? = "Ready"
      assertPresent(maybeHeadline)
      let okHeadline: string = maybeHeadline
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("does not expose external class names in extends clauses unless they are imported", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "preact-like",
      dedent`
        export abstract class Component<P, S> {
          constructor(props?: P, context?: any);
          state: Readonly<S>;
        }

        export function h(): void;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { h } from "preact-like"

      class Clock extends Component<any, { time: number }> {
      }
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toContain(
      "Unknown type 'Component<any, { time: number }>'. Expected builtin type (int, number, string, boolean, bigint, long, void) or declared class/interface/type parameter"
    );
  });

  it("supports preact-style merged component declarations with optional static methods", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "preact-like",
      dedent`
        export interface Component<P = {}, S = {}> {
          state: Readonly<S>;
        }

        export abstract class Component<P, S> {
          constructor(props?: P, context?: any);
          state: Readonly<S>;
          static getDerivedStateFromProps?(props: Readonly<P>, state: Readonly<S>): Partial<S> | null;
          setState<K extends keyof S>(state: Pick<S, K> | Partial<S> | null, callback?: () => void): void;
        }
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Component } from "preact-like"

      class Clock extends Compo^^^nent<{ label: string }, { time: number }> {
        state: { time: number }

        constructor() {
          super()
          this.state = { time: Date.now() }
        }

        componentDidMount() {
          this.setState({ time: Date.now() })
        }
      }
    `;
    const hoverOffset = source.indexOf("Compo^^^nent") + "Compo".length;
    const cleanSource = source.replace("^^^", "");
    await writeFile(mainPath, cleanSource, "utf8");

    const session = createAnalysisSession(cleanSource);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(
      cleanSource,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );

    const prefix = cleanSource.slice(0, hoverOffset);
    const hoverLine = prefix.split("\n").length - 1;
    const hoverCharacter = hoverOffset - prefix.lastIndexOf("\n") - 1;
    const hover = richSession.analysis?.getHoverAt(hoverLine, hoverCharacter + 2);

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
    expect(hover?.contents).toContain("Component");
  });

  it("uses merged interface generic defaults for imported classes when the class omits them", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "preact-like",
      dedent`
        export interface Component<P = {}, S = {}> {
          state: Readonly<S>;
        }

        export abstract class Component<P, S> {
          constructor(props?: P, context?: any);
          state: Readonly<S>;
          setState<K extends keyof S>(
            state:
              | ((
                  prevState: Readonly<S>,
                  props: Readonly<P>
                ) => Pick<S, K> | Partial<S> | null)
              | (Pick<S, K> | Partial<S> | null),
            callback?: () => void
          ): void;
        }
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Component } from "preact-like"

      class Clock extends Component {
        state: { time: number }

        constructor() {
          super()
          this.state = { time: Date.now() }
        }

        componentDidMount() {
          this.setState({ time: Date.now() })
        }
      }
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("uses inferred subclass state when merged imported classes omit explicit generic arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "preact-like",
      dedent`
        export interface Component<P = {}, S = {}> {
          state: Readonly<S>;
        }

        export abstract class Component<P, S> {
          constructor(props?: P, context?: any);
          state: Readonly<S>;
          setState<K extends keyof S>(
            state:
              | ((
                  prevState: Readonly<S>,
                  props: Readonly<P>
                ) => Pick<S, K> | Partial<S> | null)
              | (Pick<S, K> | Partial<S> | null),
            callback?: () => void
          ): void;
        }
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Component } from "preact-like"

      class Clock extends Component {
        var state = { time: Date.now() }

        componentDidMount() {
          this.setState({ time: Date.now() })
        }
      }
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

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("treats DOM nodes as structurally assignable to preact ContainerNode", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "preact",
      dedent`
        export interface ContainerNode {
          readonly nodeType: number;
          readonly parentNode: ContainerNode | null;
          readonly firstChild: ContainerNode | null;
          readonly childNodes: ArrayLike<ContainerNode>;
          contains(other: ContainerNode | null): boolean;
          insertBefore<T extends ContainerNode>(node: T, child: ContainerNode | null): T;
          appendChild<T extends ContainerNode>(node: T): T;
          removeChild<T extends ContainerNode>(child: T): T;
        }

        export function render(vnode: unknown, parent: ContainerNode): void;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { render } from "preact"

      interface ArrayLike<T> {
        readonly length: int;
        readonly [n: number]: T;
      }

      interface NodeListOf<TNode extends Node> extends ArrayLike<TNode> {
        [index: number]: TNode;
      }

      interface ParentNode extends Node {
      }

      interface ChildNode extends Node {
      }

      interface Node {
        readonly nodeType: number;
        readonly parentNode: ParentNode | null;
        readonly firstChild: ChildNode | null;
        readonly childNodes: NodeListOf<ChildNode>;
        contains(other: Node | null): boolean;
        insertBefore<T extends Node>(node: T, child: Node | null): T;
        appendChild<T extends Node>(node: T): T;
        removeChild<T extends Node>(child: T): T;
      }

      interface HTMLElement extends Node {
      }

      interface HTMLDivElement extends HTMLElement {
      }

      declare const div: HTMLDivElement
      render(null, div)
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

    const messages = richSession.semanticIssues.map((issue) => issue.message);
    expect(messages).not.toContain(
      "Argument 2 of type 'HTMLDivElement' is not assignable to parameter 'parent' of type 'ContainerNode'"
    );
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
