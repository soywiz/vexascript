import { describe, expect, it, join, mkdir, mkdtemp, tmpdir, writeFile } from "../test/expect";
import { getNodeModuleTypings, findNodeModuleExportLocation, findNodeModuleMemberLocation } from "./nodeModulesTypings";
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
