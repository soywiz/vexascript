import { NodeKind } from "compiler/ast/ast";
import { describe, expect, it, join, mkdir, mkdtemp, tmpdir, writeFile } from "../test/expect";
import {
  clearNodeModuleTypingsCache,
  getNodeModuleTypings,
  getNodeModuleTypingsForImportNames,
  findNodeModuleExportLocation,
  findNodeModuleMemberLocation
} from "./nodeModulesTypings";
import { collectImportedTypeDeclarations, collectAllImportedDeclarations } from "./importedDeclarations";
import { createAnalysisSession } from "./analysisSession";
import dedent from "compiler/utils/dedent";
import { AnalysisTypeKind, typeToString } from "compiler/analysis/types";
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
      statement.kind === NodeKind.ExportStatement
      && (statement as { declaration?: { kind?: NodeKind; name?: { name?: string } } }).declaration?.kind === NodeKind.FunctionStatement
      && (statement as { declaration?: { name?: { name?: string } } }).declaration?.name?.name === "oldVersion"
    )).toBe(true);

    await writeFile(dtsPath, `export function newVersion(): void;\n`, "utf8");
    clearNodeModuleTypingsCache();

    const second = await getNodeModuleTypings(importerPath, "pkg");
    expect(second?.declarations.some((statement) =>
      statement.kind === NodeKind.ExportStatement
      && (statement as { declaration?: { kind?: NodeKind; name?: { name?: string } } }).declaration?.kind === NodeKind.FunctionStatement
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
      statement.kind === NodeKind.ExportStatement
      && (statement as { declaration?: { kind?: NodeKind; name?: { name?: string } } }).declaration?.kind === NodeKind.InterfaceStatement
      && (statement as { declaration?: { name?: { name?: string } } }).declaration?.name?.name === "Needed"
    )).toBe(true);
    expect(typings?.declarations.some((statement) =>
      statement.kind === NodeKind.ExportStatement
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

  it("collectAllImportedDeclarations assigns callable type to default imports backed by export-equals functions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const mainPath = join(root, "main.vx");
    const source = `import pkg from "pkg"\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const importedSymbols = (await collectAllImportedDeclarations(session.ast!, {
      uri: `file://${mainPath}`,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    })).importedSymbols;

    expect(typeToString(importedSymbols.get("pkg")!.type!)).toBe("(x: string) => pkg.Result & { Result: Result, helper: () => Result }");
  });

  it("default import from node_modules gets callable type instead of unknown in analysis", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(root, "pkg", MINI_DTS);

    const mainPath = join(root, "main.vx");
    const source = `import pkg from "pkg"\n`;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);

    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const importedSymbols = collected.importedSymbols;
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(importedSymbols.get("render")?.type?.kind).toBe(AnalysisTypeKind.Function);
    expect(typeToString(importedSymbols.get("render")!.type!)).toBe("(value: unknown) => string");
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
    const importedSymbols = (await collectAllImportedDeclarations(session.ast!, ctx)).importedSymbols;

    expect(typeToString(importedSymbols.get("render")!.type!)).toBe("<P>(vnode: VNode<P>, context: any) => string");
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
    const importedSymbols = (await collectAllImportedDeclarations(session.ast!, ctx)).importedSymbols;

    expect(typeToString(importedSymbols.get("defaultOptions")!.type!)).toBe("FormatterOptions");
  });

  it("preserves support declarations for rxjs-style named reexports from sibling files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "streamy");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "streamy", typings: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export { Observable } from "./Observable";
        export { of } from "./of";
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "Observable.d.ts"),
      dedent`
        export declare class Observable<T> {
          pipe(): Observable<T>;
        }
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "of.d.ts"),
      dedent`
        import { Observable } from "./Observable";
        export declare function of<T>(value: T): Observable<T>;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { of } from "streamy"
      val piped = of(1).pipe()
    `;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(collected.externalDeclarations.some((statement) => {
      const declaration = statement.kind === NodeKind.ExportStatement
        ? (statement as { declaration?: Statement }).declaration ?? statement
        : statement;
      return declaration.kind === NodeKind.ClassStatement
        && (declaration as { name?: { name?: string } }).name?.name === "Observable";
    })).toBe(true);
    expect(typeToString(collected.importedSymbols.get("of")!.type!)).toBe("<T>(value: T) => Observable<T>");
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).not.toContain(
      "Property 'pipe' does not exist on type 'unknown'"
    );
  });

  it("supports rxjs-style imported variadic tuple overloads that return helper generic classes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "streamy");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "streamy", typings: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export { Observable } from "./Observable";
        export { of } from "./of";
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "Observable.d.ts"),
      dedent`
        export declare class Observable<T> {
          pipe(): Observable<T>;
        }
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "types.d.ts"),
      dedent`
        export type ValueFromArray<A extends readonly unknown[]> =
          A extends readonly (infer T)[] ? T : never;
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "of.d.ts"),
      dedent`
        import { Observable } from "./Observable";
        import { ValueFromArray } from "./types";
        export declare function of<A extends readonly unknown[]>(...values: A): Observable<ValueFromArray<A>>;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { of } from "streamy"
      val piped = of(1, 2, 3).pipe()
    `;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(collected.externalDeclarations.some((statement) => {
      const declaration = statement.kind === NodeKind.ExportStatement
        ? (statement as { declaration?: Statement }).declaration ?? statement
        : statement;
      return declaration.kind === NodeKind.ClassStatement
        && (declaration as { name?: { name?: string } }).name?.name === "Observable";
    })).toBe(true);
    expect(typeToString(collected.importedSymbols.get("of")!.type!)).toBe(
      "<A extends readonly unknown[]>(...values: A) => Observable<ValueFromArray<A>>"
    );
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).not.toContain(
      "Property 'pipe' does not exist on type 'unknown'"
    );
  });

  it("preserves rxjs-style higher-order operator typing through imported pipe overloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "streamy");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "streamy", typings: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export { Observable } from "./Observable";
        export { of } from "./of";
        export { map } from "./operators";
        export type { OperatorFunction } from "./types";
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "Observable.d.ts"),
      dedent`
        import { OperatorFunction } from "./types";

        export declare class Observable<T> {
          pipe(): Observable<T>;
          pipe<A>(op1: OperatorFunction<T, A>): Observable<A>;
          pipe<A, B>(op1: OperatorFunction<T, A>, op2: OperatorFunction<A, B>): Observable<B>;
          subscribe(next: (value: T) => void): void;
        }
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "types.d.ts"),
      dedent`
        import { Observable } from "./Observable";

        export type OperatorFunction<T, R> = (source: Observable<T>) => Observable<R>;
        export type ValueFromArray<A extends readonly unknown[]> =
          A extends readonly (infer T)[] ? T : never;
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "of.d.ts"),
      dedent`
        import { Observable } from "./Observable";
        import { ValueFromArray } from "./types";

        export declare function of<A extends readonly unknown[]>(...values: A): Observable<ValueFromArray<A>>;
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "operators.d.ts"),
      dedent`
        import { OperatorFunction } from "./types";

        export declare function map<T, R>(project: (value: T) => R): OperatorFunction<T, R>;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { map, of } from "streamy"

      val result = of(1, 2, 3).pipe(
        map({ value ->
          return { label: String(value) }
        }),
        map({ entry ->
          return entry.lab^^^el
        })
      )

      result.subscribe({ value ->
        val ok: string = value
      })
    `);
    await writeFile(mainPath, marked.source, "utf8");

    const session = createAnalysisSession(marked.source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
    expect(richSession.analysis?.getHoverAt(marked.line, marked.character)?.contents).toContain("expression: string");
  });

  it("supports imported class members whose signatures depend on sibling helper type aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "streamy");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "streamy", typings: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export { Observable } from "./Observable";
        export { of } from "./of";
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "types.d.ts"),
      dedent`
        export type OperatorFunction<T, R> = (value: T) => R;
        export type ValueFromArray<A extends readonly unknown[]> =
          A extends readonly (infer T)[] ? T : never;
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "Observable.d.ts"),
      dedent`
        import { OperatorFunction } from "./types";
        export declare class Observable<T> {
          pipe<A>(op1: OperatorFunction<T, A>): Observable<A>;
        }
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "of.d.ts"),
      dedent`
        import { Observable } from "./Observable";
        import { ValueFromArray } from "./types";
        export declare function of<A extends readonly unknown[]>(...values: A): Observable<ValueFromArray<A>>;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { of } from "streamy"
      val piped = of(1, 2, 3).pipe({ value -> value * 2 })
    `;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).not.toContain(
      "Property 'pipe' does not exist on type 'unknown'"
    );
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).not.toContain(
      "Operator '*' is not defined for types 'T' and 'int'"
    );
  });

  it("contextually types imported callable interfaces through pipe operator helpers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "streamy");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "streamy", typings: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export { Observable } from "./Observable";
        export { of } from "./of";
        export { map } from "./map";
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "types.d.ts"),
      dedent`
        import { Observable } from "./Observable";
        export interface UnaryFunction<T, R> {
          (source: T): R;
        }
        export interface OperatorFunction<T, R> extends UnaryFunction<Observable<T>, Observable<R>> {}
        export type ValueFromArray<A extends readonly unknown[]> =
          A extends readonly (infer T)[] ? T : never;
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "Observable.d.ts"),
      dedent`
        import { OperatorFunction } from "./types";
        export declare class Observable<T> {
          pipe<A>(op1: OperatorFunction<T, A>): Observable<A>;
        }
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "of.d.ts"),
      dedent`
        import { Observable } from "./Observable";
        import { ValueFromArray } from "./types";
        export declare function of<A extends readonly unknown[]>(...values: A): Observable<ValueFromArray<A>>;
      `,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "map.d.ts"),
      dedent`
        import { OperatorFunction } from "./types";
        export declare function map<T, R>(project: (value: T, index: number) => R): OperatorFunction<T, R>;
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { map, of } from "streamy"
      val piped = of(1, 2, 3).pipe(map({ value -> value * 2 }))
    `;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    expect(collected.externalDeclarations.some((statement) => {
      const declaration = statement.kind === NodeKind.ExportStatement
        ? (statement as { declaration?: Statement }).declaration ?? statement
        : statement;
      return declaration.kind === NodeKind.TypeAliasStatement
        && (declaration as { name?: { name?: string } }).name?.name === "ValueFromArray";
    })).toBe(true);
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(typeToString(collected.importedSymbols.get("useState")!.type!)).toBe("<S>(initialState: S | () => S) => [S, Dispatch<StateUpdater<S>>]");
    expect(typeToString(collected.importedSymbols.get("render")!.type!)).toBe("(vnode: unknown, parent: unknown) => void");
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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(collected.importedSymbols.get("useState")?.type?.kind).toBe(AnalysisTypeKind.Union);
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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(typeToString(collected.importedSymbols.get("useThing")!.type!)).toBe("<T>(value: T) => T");
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
        export * from "./external";
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

        declare const stringType: () => ZString;
        export { stringType as string };
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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(typeToString(collected.importedSymbols.get("z")!.type!)).toContain("string");
    expect(collected.invalidImportedBindings.has("z")).toBe(false);
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("resolves namespace const members declared as typeof function declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "pkg");
    const libDir = join(pkgDir, "lib");
    await mkdir(libDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), 'export * from "./lib";\n', "utf8");
    await writeFile(
      join(libDir, "index.d.ts"),
      dedent`
        import * as pkg from "./external";
        export * from "./external";
        export { pkg };
      `,
      "utf8"
    );
    await writeFile(
      join(libDir, "external.d.ts"),
      dedent`
        export interface Thing {
          value: string;
        }

        declare function createThing(name: string): Thing;
        declare const makeThing: typeof createThing;
        export { makeThing };
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { pkg } from "pkg"

      const thing = pkg.makeThing("Ada")
      const value: string = thing.val^^^ue
    `);
    await writeFile(mainPath, marked.source, "utf8");

    const session = createAnalysisSession(marked.source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
    expect(richSession.analysis?.getHoverAt(marked.line, marked.character)?.contents).toContain("string");
  });

  it("supports zod-style namespace builders and z.infer type extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "zod");
    const libDir = join(pkgDir, "lib");
    await mkdir(libDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "zod", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export * from "./lib";
        export as namespace Zod;
      `,
      "utf8"
    );
    await writeFile(
      join(libDir, "index.d.ts"),
      dedent`
        import * as z from "./external";
        export * from "./external";
        export { z };
        export default z;
      `,
      "utf8"
    );
    await writeFile(
      join(libDir, "external.d.ts"),
      dedent`
        export interface ZType<Output> {
          parse(value: unknown): Output;
          _output: Output;
        }

        export interface ZString extends ZType<string> {
          min(size: number): ZString;
        }

        export interface ZNumber extends ZType<number> {
          int(): ZNumber;
        }

        export interface ZBoolean extends ZType<boolean> {
        }

        export interface ZArray<T extends ZType<any>> extends ZType<output<T>[]> {
        }

        export type output<T extends ZType<any>> = T["_output"];
        export type infer<T extends ZType<any>> = output<T>;
        export type ZRawShape = { [key: string]: ZType<any> };
        export type objectOutput<TShape extends ZRawShape> = {
          [K in keyof TShape]: output<TShape[K]>;
        };

        export interface ZObject<TShape extends ZRawShape> extends ZType<objectOutput<TShape>> {
          shape: TShape;
        }

        declare const stringType: () => ZString;
        declare const numberType: () => ZNumber;
        declare const booleanType: () => ZBoolean;
        declare function array<T extends ZType<any>>(schema: T): ZArray<T>;
        declare function object<TShape extends ZRawShape>(shape: TShape): ZObject<TShape>;

        export { stringType as string, numberType as number, booleanType as boolean, array, object };
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { z } from "zod"

      val schema = z.object({
        name: z.string(),
        age: z.number(),
        tags: z.array(z.string()),
        active: z.boolean()
      })
      val parsed: z.inf^^^er<typeof schema> = schema.parse({
        name: "Ada",
        age: 42,
        tags: ["types", "runtime"],
        active: true
      })
      val upper = parsed.name.toUpperCase()
      val fixed = parsed.age.toFixed()
      val first = parsed.tags[0].toUpperCase()
      val enabled: boolean = parsed.active
    `);
    await writeFile(mainPath, marked.source, "utf8");

    const session = createAnalysisSession(marked.source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(collected.invalidImportedBindings.has("z")).toBe(false);
    expect(typeToString(collected.importedSymbols.get("z")!.type!)).toContain("infer");
    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("specializes real zod-style object output through mapped helper aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "zod");
    const libDir = join(pkgDir, "lib");
    await mkdir(libDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "zod", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), `export * from "./lib";\n`, "utf8");
    await writeFile(
      join(libDir, "index.d.ts"),
      dedent`
        import * as z from "./external";
        export * from "./external";
        export { z };
      `,
      "utf8"
    );
    await writeFile(
      join(libDir, "external.d.ts"),
      dedent`
        export interface ZodTypeDef {}
        export declare abstract class ZodType<Output = any, Def extends ZodTypeDef = ZodTypeDef, Input = Output> {
          readonly _output: Output;
          readonly _input: Input;
          parse(value: unknown): Output;
        }

        export type ZodTypeAny = ZodType<any, any, any>;
        export type TypeOf<T extends ZodType<any, any, any>> = T["_output"];
        export type output<T extends ZodType<any, any, any>> = T["_output"];
        export type infer<T extends ZodType<any, any, any>> = TypeOf<T>;
        export type ZodRawShape = { [k: string]: ZodTypeAny };

        export interface ZodStringDef extends ZodTypeDef {}
        export declare class ZodString extends ZodType<string, ZodStringDef, string> {
          min(size: number): ZodString;
        }

        export interface ZodBooleanDef extends ZodTypeDef {}
        export declare class ZodBoolean extends ZodType<boolean, ZodBooleanDef, boolean> {}

        export type Primitive = string | number | boolean | null | undefined;
        export interface ZodLiteralDef<T = any> extends ZodTypeDef {}
        export declare class ZodLiteral<T> extends ZodType<T, ZodLiteralDef<T>, T> {}

        export type EnumValues = readonly [string, ...string[]];
        export declare class ZodEnum<T extends EnumValues> extends ZodType<T[number], ZodTypeDef, T[number]> {}

        export type ZodUnionOptions = readonly [ZodTypeAny, ...ZodTypeAny[]];
        export declare class ZodUnion<T extends ZodUnionOptions> extends ZodType<T[number]["_output"], ZodTypeDef, T[number]["_input"]> {}

        export type ArrayCardinality = "many" | "atleastone";
        export type arrayOutputType<T extends ZodTypeAny, Cardinality extends ArrayCardinality = "many"> =
          Cardinality extends "atleastone" ? [T["_output"], ...T["_output"][]] : T["_output"][];
        export interface ZodArrayDef<T extends ZodTypeAny = ZodTypeAny> extends ZodTypeDef {}
        export declare class ZodArray<T extends ZodTypeAny, Cardinality extends ArrayCardinality = "many">
          extends ZodType<arrayOutputType<T, Cardinality>, ZodArrayDef<T>, T["_input"][]> {}

        export declare namespace objectUtil {
          type optionalKeys<T extends object> = {
            [k in keyof T]: undefined extends T[k] ? k : never;
          }[keyof T];
          type requiredKeys<T extends object> = {
            [k in keyof T]: undefined extends T[k] ? never : k;
          }[keyof T];
          export type addQuestionMarks<T extends object, _O = any> = {
            [K in requiredKeys<T>]: T[K];
          } & {
            [K in optionalKeys<T>]?: T[K];
          } & {
            [k in keyof T]?: unknown;
          };
          export type identity<T> = T;
          export type flatten<T> = identity<{
            [k in keyof T]: T[k];
          }>;
        }

        export type baseObjectOutputType<Shape extends ZodRawShape> = {
          [k in keyof Shape]: Shape[k]["_output"];
        };
        export type objectOutputType<Shape extends ZodRawShape> =
          objectUtil.flatten<objectUtil.addQuestionMarks<baseObjectOutputType<Shape>>>;

        export declare class ZodObject<T extends ZodRawShape, Output = objectOutputType<T>>
          extends ZodType<Output, ZodTypeDef, Output> {
          shape: T;
        }

        declare const stringType: () => ZodString;
        declare const booleanType: () => ZodBoolean;
        declare const arrayType: <T extends ZodTypeAny>(schema: T) => ZodArray<T, "many">;
        declare function createZodEnum<U extends string, T extends readonly [U, ...U[]]>(values: T): ZodEnum<T>;
        declare const enumType: typeof createZodEnum;
        declare const literalType: <T extends Primitive>(value: T) => ZodLiteral<T>;
        declare const unionType: <T extends readonly [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]>(types: T) => ZodUnion<T>;
        declare const objectType: <T extends ZodRawShape>(shape: T) => ZodObject<T, {
          [k in keyof objectUtil.addQuestionMarks<baseObjectOutputType<T>, any>]:
            objectUtil.addQuestionMarks<baseObjectOutputType<T>, any>[k];
        }>;

        export { stringType as string, booleanType as boolean, arrayType as array, enumType as enum, literalType as literal, unionType as union, objectType as object };
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { z } from "zod"

      const SettingsSchema = z.object({
        tags: z.array(z.string()),
        active: z.boolean()
      })
      type Settings = z.infer<typeof SettingsSchema>
      const settings: Settings = SettingsSchema.parse({
        tags: ["types", "runtime"],
        active: true
      })
      const RoleSchema = z.enum(["admin", "user"])
      type Role = z.infer<typeof RoleSchema>
      const role: Role = RoleSchema.parse("admin")
      const UnionRoleSchema = z.union([z.literal("admin"), z.literal("user")])
      type UnionRole = z.infer<typeof UnionRoleSchema>
      const unionRole: UnionRole = UnionRoleSchema.parse("user")
      const firstTag: string = settings.ta^^^gs[0]
      const enabled: boolean = settings.active
      const roleLabel: string = role.toUpperCase()
      const unionRoleLabel: string = unionRole.toUpperCase()
    `);
    await writeFile(mainPath, marked.source, "utf8");

    const session = createAnalysisSession(marked.source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
    expect(richSession.analysis?.getHoverAt(marked.line, marked.character)?.contents).toContain("string[]");
    expect(typeToString(richSession.analysis?.getTopLevelSymbolType("role")!)).toBe("string");
    expect(typeToString(richSession.analysis?.getTopLevelSymbolType("unionRole")!)).toBe("string");
  });

  it("keeps zod inferred object properties specialized through a named type alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "zod");
    const libDir = join(pkgDir, "lib");
    await mkdir(libDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "zod", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export * from "./lib";
        export as namespace Zod;
      `,
      "utf8"
    );
    await writeFile(
      join(libDir, "index.d.ts"),
      dedent`
        import * as z from "./external";
        export * from "./external";
        export { z };
        export default z;
      `,
      "utf8"
    );
    await writeFile(
      join(libDir, "external.d.ts"),
      dedent`
        export interface ZType<Output> {
          parse(value: unknown): Output;
          _output: Output;
        }

        export interface ZString extends ZType<string> {
          min(size: number): ZString;
        }

        export interface ZNumber extends ZType<number> {
          int(): ZNumber;
        }

        export type output<T extends ZType<any>> = T["_output"];
        export type infer<T extends ZType<any>> = output<T>;
        export type ZRawShape = { [key: string]: ZType<any> };
        export type objectOutput<TShape extends ZRawShape> = {
          [K in keyof TShape]: output<TShape[K]>;
        };

        export interface ZObject<TShape extends ZRawShape> extends ZType<objectOutput<TShape>> {
          shape: TShape;
        }

        declare const stringType: () => ZString;
        declare const numberType: () => ZNumber;
        declare function object<TShape extends ZRawShape>(shape: TShape): ZObject<TShape>;

        export { stringType as string, numberType as number, object };
      `,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { z } from "zod"

      const UserSchema = z.object({
        name: z.string().min(1),
        age: z.number().int()
      })

      type User = z.infer<typeof UserSchema>

      const user: User = UserSchema.parse({
        name: "Ada",
        age: 42
      })

      console.log(user.na^^^me)
    `);
    await writeFile(mainPath, marked.source, "utf8");

    const session = createAnalysisSession(marked.source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(richSession.analysis?.getIssues().map((issue) => issue.message)).toEqual([]);
    expect(richSession.analysis?.getHoverAt(marked.line, marked.character)?.contents).toContain("string");
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

    expect(typeToString(collected.importedSymbols.get("useThing")!.type!)).toBe("<T>(value: T) => T");
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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(typeToString(collected.importedSymbols.get("useThing")!.type!)).toBe("<TData, TError>() => UseThingResult<TData, TError>");
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
    const richSession = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(typeToString(collected.importedSymbols.get("useEffect")!.type!)).toBe("(effect: EffectCallback, inputs: Inputs) => void");
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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
      statement.kind === NodeKind.ExportStatement
      && (statement as { declaration?: { kind?: NodeKind; name?: { name?: string } } }).declaration?.kind === NodeKind.InterfaceStatement
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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
      statement.kind === NodeKind.ExportStatement
      && (statement as { declaration?: { kind?: NodeKind; name?: { name?: string } } }).declaration?.kind === NodeKind.ClassStatement
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
      statement.kind === NodeKind.ExportStatement
      && (statement as { declaration?: { kind?: NodeKind; name?: { name?: string } } }).declaration?.kind === NodeKind.ClassStatement
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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(collected.externalDeclarations.some((statement) => statement.kind === NodeKind.ImportStatement)).toBe(true);
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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(
      collected.externalDeclarations.some((statement) => {
        const declaration = statement.kind === NodeKind.ExportStatement
          ? (statement as { declaration?: Statement }).declaration
          : statement;
        return declaration?.kind === NodeKind.VarStatement
          && (declaration as VarStatement).name.kind === NodeKind.Identifier
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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(typeToString(collected.importedSymbols.get("ComponentChildren")!.type!)).toBe("ComponentChildren");
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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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

  it("findNodeModuleExportLocation resolves exported namespaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const source = dedent`
      export namespace Models {
        export interface User {
          name: string;
        }
      }
    `;
    await makePackageWithTypings(root, "shape-kit", source);

    const importerPath = join(root, "main.vx");
    const location = await findNodeModuleExportLocation(importerPath, "shape-kit", "Models");
    const memberLocation = await findNodeModuleMemberLocation(importerPath, "shape-kit", "Models", "User");

    expect(location).not.toBeNull();
    expect(location?.range.start.line).toBe(0);
    expect(memberLocation).not.toBeNull();
    expect(memberLocation?.range.start.line).toBe(1);
  });

  it("findNodeModuleExportLocation resolves export-star namespace reexports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "shape-kit");

    await mkdir(join(pkgDir, "src"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "shape-kit",
        types: "./index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), 'export * as Models from "./src/models";\n', "utf8");
    await writeFile(
      join(pkgDir, "src", "models.d.ts"),
      dedent`
        export interface User {
          name: string;
        }
      `,
      "utf8"
    );

    const importerPath = join(root, "main.vx");
    const location = await findNodeModuleExportLocation(importerPath, "shape-kit", "Models");
    const memberLocation = await findNodeModuleMemberLocation(importerPath, "shape-kit", "Models", "User");

    expect(location).not.toBeNull();
    expect(location?.typingsPath).toContain("index.d.ts");
    expect(location?.range.start.line).toBe(0);
    expect(memberLocation).not.toBeNull();
    expect(memberLocation?.typingsPath).toContain("src/models.d.ts");
    expect(memberLocation?.range.start.line).toBe(0);
  });

  it("collectAllImportedDeclarations exposes export-star namespace reexports as named imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "shape-kit");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Models } from "shape-kit"

      const user: Models.User = { name: "Ada" }
      const userName = user.name
    `;

    await mkdir(join(pkgDir, "src"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "shape-kit",
        types: "./index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), 'export * as Models from "./src/models";\n', "utf8");
    await writeFile(
      join(pkgDir, "src", "models.d.ts"),
      dedent`
        export interface User {
          name: string;
        }
      `,
      "utf8"
    );
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(source, {
      externalDeclarations: collected.externalDeclarations,
      importedSymbols: collected.importedSymbols
    });

    expect(collected.importedSymbols.has("Models")).toBe(true);
    expect(typeToString(richSession.analysis?.getTopLevelSymbolType("userName")!)).toBe("string");
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

  it("findNodeModuleExportLocation resolves aliased export specifiers from export-star branches", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "zod-like");
    const libDir = join(pkgDir, "lib");

    await mkdir(libDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "zod-like",
        types: "./index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), 'export * from "./lib";\n', "utf8");
    await writeFile(
      join(libDir, "index.d.ts"),
      dedent`
        export * from "./types";
      `,
      "utf8"
    );
    await writeFile(
      join(libDir, "types.d.ts"),
      dedent`
        declare const objectType: (shape: unknown) => { shape: unknown };
        export { objectType as object };
      `,
      "utf8"
    );

    const importerPath = join(root, "main.vx");
    const location = await findNodeModuleExportLocation(importerPath, "zod-like", "object");

    expect(location).not.toBeNull();
    expect(location?.typingsPath).toContain("lib/types.d.ts");
    expect(location?.range.start.line).toBe(0);
    expect(location?.range.start.character).toBe(14);
  });

  it("findNodeModuleExportLocation resolves aliased default reexports to the source declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    const pkgDir = join(root, "node_modules", "shape-kit");

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "shape-kit",
        types: "./index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), 'export { createSchema as default } from "./factory";\n', "utf8");
    await writeFile(
      join(pkgDir, "factory.d.ts"),
      dedent`
        export interface Schema {
          title: string;
        }

        export function createSchema(): Schema;
      `,
      "utf8"
    );

    const importerPath = join(root, "main.vx");
    const location = await findNodeModuleExportLocation(importerPath, "shape-kit", "default");

    expect(location).not.toBeNull();
    expect(location?.typingsPath).toContain("factory.d.ts");
    expect(location?.range.start.line).toBe(4);
    expect(location?.range.start.character).toBe(16);
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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(richSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("resolves readonly array conditional infer aliases from imported declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-nm-typings-"));
    await makePackageWithTypings(
      root,
      "infer-box",
      dedent`
        export type ReadonlyElement<T> = T extends readonly (infer U)[] ? U : T;
        export type ReadonlyElementValue = ReadonlyElement<readonly string[]>;
        export type ReadonlyTupleElementValue = ReadonlyElement<readonly [string, string]>;
      `
    );

    const mainPath = join(root, "main.vx");
    const source = dedent`
      import type { ReadonlyElementValue, ReadonlyTupleElementValue } from "infer-box"

      let element: ReadonlyElementValue = "Ada"
      let tupleElement: ReadonlyTupleElementValue = "Lovelace"
    `;
    await writeFile(mainPath, source, "utf8");

    const session = createAnalysisSession(source);
    const ctx = { uri: `file://${mainPath}`, sourceRoots: [root], getSessionForFilePath: () => null };
    const collected = await collectAllImportedDeclarations(session.ast!, ctx);
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(cleanSource, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

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
    const richSession = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    const messages = richSession.semanticIssues.map((issue) => issue.message);
    expect(messages).not.toContain(
      "Argument 2 of type 'HTMLDivElement' is not assignable to parameter 'parent' of type 'ContainerNode'"
    );
  });

  it("collectAllImportedDeclarations returns empty results for unknown file URI", async () => {
    const session = createAnalysisSession(`import pkg from "pkg"\n`);
    const result = await collectAllImportedDeclarations(session.ast!, {
      sourceRoots: [],
      getSessionForFilePath: () => null
    });
    expect(result.externalDeclarations).toEqual([]);
    expect(result.importedSymbols.size).toBe(0);
  });
});
