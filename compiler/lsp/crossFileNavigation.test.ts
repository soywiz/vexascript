import { NodeKind } from "compiler/ast/ast";
import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, readFile, tmpdir, writeFile } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { ensureDomProgram, getDomDeclarationFilePath } from "compiler/runtime/domDeclarations";
import { loadAmbientTypesForProject } from "./ambientTypesLoader";
import { collectAllImportedDeclarations, collectImportedTypeDeclarations } from "./importedDeclarations";
import {
  resolveDefinitionAcrossFiles,
  resolveDefinitionTargetsWithLocalFallback,
  resolveDefinitionWithLocalFallback,
  resolveImplementationsAcrossFiles,
  resolveMemberHoverAcrossFiles,
  resolveHoverWithLocalFallback,
  resolvePrepareRenameAcrossFiles,
  resolveReferencesAcrossFiles,
  resolveRenameAcrossFiles
} from "./crossFileNavigation";
import { resolveImportPathHover } from "./importPathNavigation";
import { pathToUri } from "./importFixes";
import {
  ensureEcmaScriptRuntimeProgram,
  getEcmaScriptRuntimeDeclarationFilePath,
  getEcmaScriptRuntimeProgram,
  getVexaScriptRuntimeDeclarationFilePath
} from "compiler/runtime/ecmascriptDeclarations";
import { Vfs } from "compiler/vfs";
import { parseSource } from "compiler/pipeline/parse";
import type { Statement } from "compiler/ast/ast";
import { findAmbientNamedExportRange } from "./crossFileContext";

class MyVfs extends Vfs {
    constructor(public virtualDomPath: string, public domSource: string) {
      super()
    }

    override async readFile(filePath: string) {
      if (filePath !== this.virtualDomPath) throw new Error()
      return this.domSource
    }
    override async stat(filePath: string) {
      if (filePath !== this.virtualDomPath) throw new Error()
      return { mtimeMs: 0, isFile: true, isDirectory: false }
    }
}

function parseAmbientModule(src: string, moduleName: string): Statement[] {
  const result = parseSource(src, { language: "typescript" });
  const namespace = result.ast?.body.find(
    (statement) =>
      statement.kind === NodeKind.NamespaceStatement &&
      (statement as { externalModuleName?: { value: string } }).externalModuleName?.value === moduleName
  ) as { body?: { body?: Statement[] } } | undefined;
  return namespace?.body?.body ?? [];
}

describe("cross-file navigation", () => {
  it("navigates an overriding method declaration to the base method", async () => {
    const marked = sourceWithCursor(dedent`
      class Base {
        run(): void {}
      }

      class Child extends Base {
        override ru^^^n(): void {}
      }
    `);
    const session = createAnalysisSession(marked.source);

    const location = await resolveDefinitionWithLocalFallback({
      uri: "file:///virtual/main.vx",
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: []
    });

    expect(location).toEqual({
      uri: "file:///virtual/main.vx",
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 5 }
      }
    });
  });

  it("offers every overriding method when navigating from the base declaration", async () => {
    const marked = sourceWithCursor(dedent`
      class Base {
        ru^^^n(): void {}
      }

      class Child extends Base {
        override run(): void {}
      }

      class GrandChild extends Child {
        override run(): void {}
      }

      class Sibling extends Base {
        override run(): void {}
      }

      class Unrelated {
        run(): void {}
      }
    `);
    const session = createAnalysisSession(marked.source);

    const locations = await resolveDefinitionTargetsWithLocalFallback({
      uri: "file:///virtual/main.vx",
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: []
    });

    expect(Array.isArray(locations)).toBe(true);
    expect((locations as Array<{ range: { start: { line: number } } }>)
      .map((location) => location.range.start.line)).toEqual([5, 9, 13]);
  });

  it("finds the base method and every overriding implementation", async () => {
    const marked = sourceWithCursor(dedent`
      class Base {
        run(): void {}
      }

      class Child extends Base {
        override ru^^^n(): void {}
      }

      class GrandChild extends Child {
        override run(): void {}
      }

      class Sibling extends Base {
        override run(): void {}
      }

      class Unrelated {
        run(): void {}
      }
    `);
    const session = createAnalysisSession(marked.source);

    const locations = await resolveImplementationsAcrossFiles({
      uri: "file:///virtual/main.vx",
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: []
    });

    expect(locations.map((location) => location.range.start.line)).toEqual([1, 5, 9, 13]);
  });

  it("finds method implementations connected through an interface", async () => {
    const marked = sourceWithCursor(dedent`
      interface Runner {
        run(): void
      }

      class First implements Runner {
        override ru^^^n(): void {}
      }

      class Second implements Runner {
        override run(): void {}
      }
    `);
    const session = createAnalysisSession(marked.source);
    const context = {
      uri: "file:///virtual/main.vx",
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: []
    };

    const definition = await resolveDefinitionWithLocalFallback(context);
    const implementations = await resolveImplementationsAcrossFiles(context);

    expect(definition?.range.start.line).toBe(1);
    expect(implementations.map((location) => location.range.start.line)).toEqual([1, 5, 9]);
  });

  it("navigates and finds overriding methods across project files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-method-hierarchy-"));
    const baseFile = join(root, "Base.vx");
    const childFile = join(root, "Child.vx");
    const siblingFile = join(root, "Sibling.vx");
    const base = sourceWithCursor(dedent`
      export class Base {
        ru^^^n(): void {}
      }
    `);
    const child = sourceWithCursor(dedent`
      import { Base } from "./Base.vx"
      export class Child extends Base {
        override ru^^^n(): void {}
      }
    `);
    const siblingSource = dedent`
      import { Base } from "./Base.vx"
      export class Sibling extends Base {
        override run(): void {}
      }
    `;
    await writeFile(baseFile, base.source, "utf8");
    await writeFile(childFile, child.source, "utf8");
    await writeFile(siblingFile, siblingSource, "utf8");
    const sessions = new Map([
      [baseFile, createAnalysisSession(base.source)],
      [childFile, createAnalysisSession(child.source)],
      [siblingFile, createAnalysisSession(siblingSource)]
    ]);
    let sessionRequests = 0;
    const context = {
      uri: pathToFileURL(childFile).toString(),
      line: child.line,
      character: child.character,
      session: sessions.get(childFile)!,
      sourceRoots: [root],
      getSessionForFilePath: (filePath: string) => {
        sessionRequests += 1;
        return sessions.get(filePath) ?? null;
      }
    };

    const definition = await resolveDefinitionWithLocalFallback(context);
    const implementations = await resolveImplementationsAcrossFiles(context);

    expect(definition).toEqual({
      uri: pathToFileURL(baseFile).toString(),
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 5 }
      }
    });
    expect(implementations.map((location) => location.uri)).toEqual([
      pathToFileURL(baseFile).toString(),
      pathToFileURL(childFile).toString(),
      pathToFileURL(siblingFile).toString()
    ]);
    expect(sessionRequests).toBeLessThanOrEqual(16);

    sessionRequests = 0;
    const baseTargets = await resolveDefinitionTargetsWithLocalFallback({
      ...context,
      uri: pathToFileURL(baseFile).toString(),
      line: base.line,
      character: base.character,
      session: sessions.get(baseFile)!
    });
    expect((baseTargets as Array<{ uri: string }>).map((location) => location.uri)).toEqual([
      pathToFileURL(childFile).toString(),
      pathToFileURL(siblingFile).toString()
    ]);
    expect(sessionRequests).toBeLessThanOrEqual(16);
  });

  it("resolves an extends-clause class reference to the imported base constructor", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-base-constructor-navigation-"));
    const baseFile = join(root, "GameObject.vx");
    const derivedFile = join(root, "BlockEnemy.vx");
    const declared = sourceWithCursor(dedent`
      export class GameObject {
        constr^^^uctor(scene: string, name: string) {
        }
      }
    `);
    const usage = sourceWithCursor(dedent`
      import { GameObject } from "./GameObject.vx"
      class BlockEnemy extends GameO^^^bject() {
      }
    `);
    await writeFile(baseFile, declared.source, "utf8");
    await writeFile(derivedFile, usage.source, "utf8");

    const baseSession = createAnalysisSession(declared.source);
    const initialDerivedSession = createAnalysisSession(usage.source);
    const collected = await collectAllImportedDeclarations(initialDerivedSession.ast!, {
      uri: pathToFileURL(derivedFile).toString(),
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => filePath === baseFile ? baseSession : null
    });
    const derivedSession = createAnalysisSession(usage.source, {
      externalDeclarations: collected.externalDeclarations,
      externalDeclarationLocations: collected.externalDeclarationLocations,
      importedSymbols: collected.importedSymbols,
      invalidImportedBindings: collected.invalidImportedBindings
    });
    const definition = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(derivedFile).toString(),
      line: usage.line,
      character: usage.character,
      session: derivedSession,
      sourceRoots: [root],
      getSessionForFilePath: (filePath: string) => {
        if (filePath === baseFile) return baseSession;
        if (filePath === derivedFile) return derivedSession;
        return null;
      }
    });

    expect(definition).toEqual({
      uri: pathToFileURL(baseFile).toString(),
      range: {
        start: { line: declared.line, character: declared.character - 6 },
        end: { line: declared.line, character: declared.character + 5 }
      }
    });
  });

  it("resolves named argument hover and definition to the called function parameter", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-named-argument-navigation-"));
    const geometryFile = join(root, "geometry.vx");
    const mainFile = join(root, "main.vx");
    const declared = sourceWithCursor(dedent`
      export function SDLRect(x: int, y: int, wid^^^th: int, height: int): int {
        return width
      }
    `);
    const marked = sourceWithCursor(dedent`
      import { SDLRect } from "./geometry.vx"

      const rectangle = SDLRect(x: 368, y: 193, wid^^^th: 64, height: 64)
    `);
    await writeFile(geometryFile, declared.source, "utf8");
    await writeFile(mainFile, marked.source, "utf8");

    const geometrySession = createAnalysisSession(declared.source);
    const baseSession = createAnalysisSession(marked.source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainFile).toString(),
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => filePath === geometryFile ? geometrySession : null
    });
    const session = createAnalysisSession(marked.source, {
      externalDeclarations: collected.externalDeclarations,
      externalDeclarationLocations: collected.externalDeclarationLocations,
      importedSymbols: collected.importedSymbols,
      invalidImportedBindings: collected.invalidImportedBindings
    });
    const context = {
      uri: pathToFileURL(mainFile).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath: (filePath: string) => {
        if (filePath === geometryFile) return geometrySession;
        if (filePath === mainFile) return session;
        return null;
      }
    };

    const definition = await resolveDefinitionWithLocalFallback(context);
    expect(definition).toEqual({
      uri: pathToFileURL(geometryFile).toString(),
      range: {
        start: { line: declared.line, character: declared.character - 3 },
        end: { line: declared.line, character: declared.character + 2 }
      }
    });

    const hover = await resolveHoverWithLocalFallback(context);
    expect(hover).toEqual({
      contents: {
        kind: "markdown",
        value: "```typescript\nparameter width: int\n```"
      },
      range: {
        start: { line: marked.line, character: marked.character - 3 },
        end: { line: marked.line, character: marked.character + 2 }
      }
    });
  });

  it("resolves named arguments to primary constructor parameters", async () => {
    const declaration = sourceWithCursor(dedent`
      class SDLRect(
        val x: int,
        val y: int,
        val wid^^^th: int,
        val height: int
      )

      const rectangle = SDLRect(x: 368, y: 193, width: 64, height: 64)
      const bytes = ArrayBuffer(4)
    `);
    const usage = sourceWithCursor(declaration.source.replace("width: 64", "wid^^^th: 64"));
    const session = createAnalysisSession(usage.source);
    const context = {
      uri: "file:///workspace/main.vx",
      line: usage.line,
      character: usage.character,
      session,
      sourceRoots: ["/workspace"],
      getSessionForFilePath: () => null
    };

    const definition = await resolveDefinitionWithLocalFallback(context);
    expect(definition?.uri).toBe(context.uri);
    expect(definition?.range).toEqual({
      start: { line: declaration.line, character: declaration.character - 3 },
      end: { line: declaration.line, character: declaration.character + 2 }
    });

    const hover = await resolveHoverWithLocalFallback(context);
    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\nparameter width: int\n```"
    });
  });

  it("resolves constructor-style calls through variables to the new signature", async () => {
    const runtimeProgram = await ensureEcmaScriptRuntimeProgram();
    const arrayBufferConstructor = runtimeProgram.body.find(
      (statement) =>
        statement.kind === NodeKind.InterfaceStatement &&
        (statement as { name?: { name?: string } }).name?.name === "ArrayBufferConstructor"
    ) as { members?: Array<{ name?: { name?: string; firstToken?: { range: { start: { line: number; column: number }; end: { line: number; column: number } } } } }> } | undefined;
    const newSignature = arrayBufferConstructor?.members?.find((member) => member.name?.name === "constructor");
    const declarationRange = newSignature?.name?.firstToken?.range;
    expect(declarationRange).not.toBeNull();

    const marked = sourceWithCursor("const bytes = ArrayBu^^^ffer(4)");
    const session = createAnalysisSession(marked.source);
    const runtimePath = getEcmaScriptRuntimeDeclarationFilePath();
    const context = {
      uri: "file:///workspace/main.vx",
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: ["/workspace"],
      getSessionForFilePath: (filePath: string) =>
        filePath === runtimePath ? { ast: runtimeProgram, analysis: null } : null
    };

    const definition = await resolveDefinitionWithLocalFallback(context);
    expect(definition).toEqual({
      uri: pathToUri(runtimePath),
      range: {
        start: {
          line: declarationRange!.start.line,
          character: declarationRange!.start.column
        },
        end: {
          line: declarationRange!.end.line,
          character: declarationRange!.end.column
        }
      }
    });

    const hover = await resolveHoverWithLocalFallback(context);
    const hoverValue = typeof hover?.contents === "object" && "value" in hover.contents
      ? hover.contents.value
      : "";
    expect(hoverValue).toContain("new ArrayBuffer(byteLength: number): ArrayBuffer");
    expect(hover?.range).toEqual({
      start: { line: marked.line, character: marked.character - 7 },
      end: { line: marked.line, character: marked.character + 4 }
    });
  });

  it("formats resolved type alias hovers as highlighted multiline TypeScript", async () => {
    const marked = sourceWithCursor(dedent`
      type Us^^^er = {
        id: string,
        contact: { email: string, phone: string? },
        role: "admin" | "user",
        tags: string[],
        metadata: Record<string, string>
      }
    `);
    const session = createAnalysisSession(marked.source);

    const hover = await resolveHoverWithLocalFallback({
      uri: "file:///workspace/main.vx",
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: ["/workspace"],
      getSessionForFilePath: () => null
    });

    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: [
        "```typescript",
        "type User = {",
        "  id: string;",
        "  contact: {",
        "    email: string;",
        "    phone?: string;",
        "  };",
        '  role: "admin" | "user";',
        "  tags: string[];",
        "  metadata: {",
        "    [key: string]: string;",
        "  };",
        "}",
        "```"
      ].join("\n")
    });
  });

  it("formats imported type alias hovers from the declaring file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-imported-type-hover-"));
    const modelsFile = join(root, "models.vx");
    const mainFile = join(root, "main.vx");
    const modelsSource = dedent`
      export type UserEvent =
        { kind: "created", userId: string } |
        { kind: "renamed", userId: string, name: string }
    `;
    const marked = sourceWithCursor(dedent`
      import type { UserEvent } from "./models.vx"

      const event: UserEv^^^ent = { kind: "created", userId: "1" }
    `);
    await writeFile(modelsFile, modelsSource, "utf8");
    await writeFile(mainFile, marked.source, "utf8");

    const getSessionForFilePath = async (filePath: string) => {
      const source = await readFile(filePath, "utf8").catch(() => null);
      return source === null ? null : createAnalysisSession(source);
    };
    const baseSession = createAnalysisSession(marked.source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainFile).toString(),
      sourceRoots: [root],
      getSessionForFilePath
    });
    const session = createAnalysisSession(marked.source, {
      externalDeclarations: collected.externalDeclarations,
      externalDeclarationLocations: collected.externalDeclarationLocations,
      importedSymbols: collected.importedSymbols
    });

    const hover = await resolveHoverWithLocalFallback({
      uri: pathToFileURL(mainFile).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath
    });

    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: [
        "```typescript",
        "type UserEvent = {",
        '  kind: "created";',
        "  userId: string;",
        "} | {",
        '  kind: "renamed";',
        "  userId: string;",
        "  name: string;",
        "}",
        "```"
      ].join("\n")
    });
  });

  it("navigates imported values in typeof aliases to their original declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-imported-typeof-definition-"));
    const schemasPath = join(root, "schemas.vx");
    const modelsPath = join(root, "models.vx");
    const schemasSource = 'export const RoleSchema = "schema"\n';
    const marked = sourceWithCursor(dedent`
      import { RoleSchema } from "./schemas.vx"
      export type Role = typeof RoleSch^^^ema
    `);
    await writeFile(schemasPath, schemasSource, "utf8");
    await writeFile(modelsPath, marked.source, "utf8");

    const schemasSession = createAnalysisSession(schemasSource);
    const baseSession = createAnalysisSession(marked.source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(modelsPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => filePath === schemasPath ? schemasSession : null
    });
    const session = createAnalysisSession(marked.source, {
      externalDeclarations: collected.externalDeclarations,
      importedSymbols: collected.importedSymbols,
      invalidImportedBindings: collected.invalidImportedBindings
    });

    const location = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(modelsPath).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => {
        if (filePath === schemasPath) return schemasSession;
        if (filePath === modelsPath) return session;
        return null;
      }
    });

    expect(location?.uri).toBe(pathToFileURL(schemasPath).toString());
    expect(location?.range.start.line).toBe(0);
  });

  it("navigates inherited package members through a transitive local re-export", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-transitive-package-member-definition-"));
    const packageDir = join(root, "node_modules", "schema-lib");
    const typingsPath = join(packageDir, "index.d.ts");
    const schemasPath = join(root, "schemas.vx");
    const mainPath = join(root, "main.vx");
    const typingsSource = dedent`
      export interface Schema {
        parse(value: string): string;
      }
      export type PublicSchema = Schema;
      export declare const PublicUserSchema: PublicSchema;
    `;
    const schemasSource = dedent`
      import { PublicUserSchema } from "schema-lib"
      export { PublicUserSchema }
    `;
    const marked = sourceWithCursor(dedent`
      import { PublicUserSchema } from "./schemas.vx"
      PublicUserSchema.pa^^^rse("value")
    `);
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ types: "index.d.ts" }), "utf8");
    await writeFile(typingsPath, typingsSource, "utf8");
    await writeFile(schemasPath, schemasSource, "utf8");
    await writeFile(mainPath, marked.source, "utf8");

    const schemasSession = createAnalysisSession(schemasSource);
    const baseSession = createAnalysisSession(marked.source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => filePath === schemasPath ? schemasSession : null
    });
    const session = createAnalysisSession(marked.source, {
      externalDeclarations: collected.externalDeclarations,
      externalDeclarationLocations: collected.externalDeclarationLocations,
      importedSymbols: collected.importedSymbols,
      invalidImportedBindings: collected.invalidImportedBindings
    });
    const location = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => {
        if (filePath === schemasPath) return schemasSession;
        if (filePath === mainPath) return session;
        return null;
      }
    });

    expect(location?.uri).toBe(pathToFileURL(typingsPath).toString());
    expect(location?.range.start.line).toBe(1);
    expect(location?.range.start.character).toBe(2);
  });

  it("returns no fallback definition when a session has no analysis", async () => {
    const source = "const value = 1\n";
    const session = { ...createAnalysisSession(source), analysis: null };

    const location = await resolveDefinitionWithLocalFallback({
      uri: "file:///workspace/main.vx",
      line: 0,
      character: 7,
      session,
      sourceRoots: ["/workspace"],
      getSessionForFilePath: () => null
    });

    expect(location).toBeNull();
  });

  it("navigates a member whose declaration arrives through a transitive inferred import", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-transitive-member-definition-"));
    const packageDirectory = join(root, "node_modules", "signals-like");
    const packageFile = join(packageDirectory, "index.d.ts");
    const stateFile = join(root, "state.vx");
    const consumerFile = join(root, "consumer.vx");
    const marked = sourceWithCursor(dedent`
      import { visible } from "./state.vx"

      const count = visible.va^^^lue.length
    `);

    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ name: "signals-like", types: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(
      packageFile,
      dedent`
        export interface ReadonlyBox<T> {
          readonly value: T;
        }

        export function computed<T>(compute: () => T): ReadonlyBox<T>;
      `,
      "utf8"
    );
    await writeFile(
      stateFile,
      'import { computed } from "signals-like"\nexport const visible = computed(() => ["Ada"])\n',
      "utf8"
    );
    await writeFile(consumerFile, marked.source, "utf8");

    const getSessionForFilePath = async (filePath: string) => {
      const source = await readFile(filePath, "utf8").catch(() => null);
      return source === null ? null : createAnalysisSession(source);
    };
    const baseSession = createAnalysisSession(marked.source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(consumerFile).toString(),
      sourceRoots: [root],
      getSessionForFilePath
    });
    const session = createAnalysisSession(marked.source, {
      externalDeclarations: collected.externalDeclarations,
      externalDeclarationLocations: collected.externalDeclarationLocations,
      importedSymbols: collected.importedSymbols
    });

    const location = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(consumerFile).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath
    });

    expect(location?.uri).toBe(pathToFileURL(packageFile).toString());
    expect(location?.range.start).toEqual({ line: 1, character: 11 });
  });

  it("provides member hover for properties imported from local JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-json-import-hover-"));
    const jsonFile = join(root, "data.json");
    const mainFile = join(root, "main.vx");
    const source = 'import data from "./data.json"\n\ndata.title\n';
    await writeFile(jsonFile, JSON.stringify({ title: "ready", count: 3, enabled: true }), "utf8");
    await writeFile(mainFile, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainFile).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(source, {
      externalDeclarations: collected.externalDeclarations,
      importedSymbols: collected.importedSymbols
    });
    const hover = await resolveHoverWithLocalFallback({
      uri: pathToFileURL(mainFile).toString(),
      line: 2,
      character: source.split("\n")[2]!.indexOf("title") + 2,
      session,
      sourceRoots: [root]
    });

    expect((hover?.contents as { value?: string } | undefined)?.value).toBe("```typescript\ntitle: string\n```");
  });

  it("navigates JSON member access to the property key in the JSON file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-json-import-definition-"));
    const jsonFile = join(root, "data.json");
    const mainFile = join(root, "main.vx");
    const source = 'import data from "./data.json"\n\ndata.title\n';
    const jsonSource = '{\n  "title": "ready",\n  "count": 3\n}\n';
    await writeFile(jsonFile, jsonSource, "utf8");
    await writeFile(mainFile, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainFile).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(source, {
      externalDeclarations: collected.externalDeclarations,
      importedSymbols: collected.importedSymbols
    });
    const definition = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainFile).toString(),
      line: 2,
      character: source.split("\n")[2]!.indexOf("title") + 2,
      session,
      sourceRoots: [root]
    });

    expect(definition?.uri).toBe(pathToFileURL(jsonFile).toString());
    expect(definition?.range).toEqual({
      start: { line: 1, character: 3 },
      end: { line: 1, character: 8 }
    });
  });

  it("provides string member hover for local text imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-text-import-hover-"));
    const textFile = join(root, "message.txt");
    const mainFile = join(root, "main.vx");
    const source = 'import message from "./message.txt"\n\nmessage.trim()\n';
    await writeFile(textFile, "hello from text", "utf8");
    await writeFile(mainFile, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainFile).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(source, {
      externalDeclarations: collected.externalDeclarations,
      importedSymbols: collected.importedSymbols
    });
    const hover = await resolveHoverWithLocalFallback({
      uri: pathToFileURL(mainFile).toString(),
      line: 2,
      character: source.split("\n")[2]!.indexOf("trim") + 2,
      session,
      sourceRoots: [root]
    });

    expect((hover?.contents as { value?: string } | undefined)?.value).toContain("trim");
  });

  it("resolves go-to-definition from imported symbol usage to original declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");

    const sourceA = "class Point\n";
    const sourceB = "import { Point } from \"./a\"\nfun demo() {\n  return new Point()\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 2,
      character: 15,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(fileA).toString(),
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 11 }
      }
    });
  });

  it("navigates builtin annotations to the dedicated VexaScript runtime declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "main.vx");
    const source = '@JsName("renamed")\nfun demo() {}\n';

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 0,
      character: 2,
      session,
      sourceRoots: [root]
    });

    expect(location?.uri).toBe(pathToFileURL(getVexaScriptRuntimeDeclarationFilePath()).toString());
  });

  it("resolves go-to-definition for member access inside a trailing-lambda body", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "other.vx");

    const source = dedent`
      class TimeSpan(val ms: number)
      fun delay(time: TimeSpan): Promise<T> => new Promise { resolve, reject ->
        setTimeout(resolve, time.ms)
      }
      `;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    // Cursor on `ms` in `time.ms`, which lives inside the `new Promise { ... }`
    // trailing lambda body.
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 2,
      character: source.split("\n")[2]!.indexOf(".ms") + 2,
      session,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(file).toString(),
      range: {
        start: { line: 0, character: 19 },
        end: { line: 0, character: 21 }
      }
    });
  });

  it("resolves property-reference member hover and definition like member access", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-property-ref-nav-"));
    const vectorPath = join(root, "vector.vx");
    const mainPath = join(root, "main.vx");

    const vectorSource = "export class Vec2(val x: number, val y: number)\n";
    const source = dedent`
      import { Vec2 } from "./vector"

      val center = Vec2(1, 2)
      val dotValue = center.x
      val propertyRef = center::x
    `;

    await writeFile(vectorPath, vectorSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const vectorSession = createAnalysisSession(vectorSource);
    const baseSession = createAnalysisSession(source);
    const getSessionForFilePath = (filePath: string) => {
      if (filePath === vectorPath) {
        return vectorSession;
      }
      if (filePath === mainPath) {
        return baseSession;
      }
      return null;
    };
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath
    });
    const session = createAnalysisSession(source, {
      externalDeclarations: collected.externalDeclarations,
      importedSymbols: collected.importedSymbols,
      invalidImportedBindings: collected.invalidImportedBindings
    });

    const lines = source.split("\n");
    const dotLine = lines.findIndex((line) => line.includes("center.x"));
    const refLine = lines.findIndex((line) => line.includes("center::x"));
    const dotCharacter = lines[dotLine]!.indexOf("center.x") + "center.".length;
    const refCharacter = lines[refLine]!.indexOf("center::x") + "center::".length;
    const context = {
      uri: pathToFileURL(mainPath).toString(),
      session,
      sourceRoots: [root],
      getSessionForFilePath
    };

    const dotHover = await resolveHoverWithLocalFallback({
      ...context,
      line: dotLine,
      character: dotCharacter
    });
    const refHover = await resolveHoverWithLocalFallback({
      ...context,
      line: refLine,
      character: refCharacter
    });
    const dotDefinition = await resolveDefinitionWithLocalFallback({
      ...context,
      line: dotLine,
      character: dotCharacter
    });
    const refDefinition = await resolveDefinitionWithLocalFallback({
      ...context,
      line: refLine,
      character: refCharacter
    });

    expect((dotHover?.contents as { value?: string } | undefined)?.value).toContain("x: number");
    expect((refHover?.contents as { value?: string } | undefined)?.value).toContain("x: number");
    expect(dotDefinition).toEqual(refDefinition);
    expect(refDefinition).toEqual({
      uri: pathToFileURL(vectorPath).toString(),
      range: {
        start: { line: 0, character: vectorSource.indexOf("x: number") },
        end: { line: 0, character: vectorSource.indexOf("x: number") + 1 }
      }
    });
  });

  it("resolves merged node_modules class members from class declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-merged-members-"));
    const pkgDir = join(root, "node_modules", "pkg");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Widget } from "pkg"

      fun demo() {
        val widget = new Widget()
        widget.drawRoundedRect(0, 0, 10, 20, 5)
        widget.x = 1
      }
    `;
    const pkgSource = dedent`
      export interface Base {
      }

      export declare class Base {
        x: number;
      }

      export interface Widget extends Base {
      }

      export declare class Widget extends Base {
        drawRoundedRect(x: number, y: number, width: number, height: number, radius: number): this;
      }
    `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pkg",
        types: "index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), pkgSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    const lines = source.split("\n");
    const pkgLines = pkgSource.split("\n");
    const methodLine = lines.findIndex((line) => line.includes("widget.drawRoundedRect"));
    const propertyLine = lines.findIndex((line) => line.includes("widget.x = 1"));
    const methodCharacter = lines[methodLine]!.indexOf("drawRoundedRect") + 2;
    const propertyCharacter = lines[propertyLine]!.indexOf(".x") + 2;
    const methodDefinitionLine = pkgLines.findIndex((line) => line.includes("drawRoundedRect"));
    const propertyDefinitionLine = pkgLines.findIndex((line) => line.includes("x: number"));

    const methodHover = await resolveHoverWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: methodLine,
      character: methodCharacter,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const methodDefinition = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: methodLine,
      character: methodCharacter,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const propertyHover = await resolveHoverWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: propertyLine,
      character: propertyCharacter,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const propertyDefinition = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: propertyLine,
      character: propertyCharacter,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect((methodHover?.contents as { value?: string } | undefined)?.value).toContain("drawRoundedRect");
    expect((methodHover?.contents as { value?: string } | undefined)?.value).toContain("radius: number");
    expect(methodDefinition?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(methodDefinition?.range.start.line).toBe(methodDefinitionLine);

    expect((propertyHover?.contents as { value?: string } | undefined)?.value).toContain("x: number");
    expect(propertyDefinition?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(propertyDefinition?.range.start.line).toBe(propertyDefinitionLine);
  });

  it("resolves contextual object-literal property keys to their node_modules declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-object-literal-property-nav-"));
    const pkgDir = join(root, "node_modules", "pixi.js");
    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { Application } from "pixi.js"

      val app = Application()
      await app.init({
        width: 480,
        height: 320,
        resolution: 1,
        antial^^^ias: true,
      })
    `);
    const pkgSource = dedent`
      export interface ApplicationOptions {
        width?: number;
        height?: number;
        resolution?: number;
        antialias?: boolean;
      }

      export class Application {
        init(options: Partial<ApplicationOptions>): Promise<void>;
      }
    `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pixi.js",
        types: "index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), pkgSource, "utf8");
    await writeFile(mainPath, marked.source, "utf8");

    const baseSession = createAnalysisSession(marked.source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    const pkgLines = pkgSource.split("\n");
    const antialiasLine = pkgLines.findIndex((line) => line.includes("antialias?: boolean"));
    const hover = await resolveHoverWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const location = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect((hover?.contents as { value?: string } | undefined)?.value).toContain("antialias: boolean");
    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(location?.range.start.line).toBe(antialiasLine);
    expect(location?.range.start.character).toBe(2);
    expect(location?.range.end.character).toBe(11);
  });

  it("resolves contextual object-literal properties inherited through node_modules mixin namespaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-object-literal-mixin-property-nav-"));
    const pkgDir = join(root, "node_modules", "pixi-like");
    const appDir = join(pkgDir, "app");
    const renderingDir = join(pkgDir, "rendering");
    const renderersDir = join(renderingDir, "renderers");
    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { Application } from "pixi-like"

      val app = Application()
      await app.init({
        width: 480,
        antial^^^ias: true,
      })
    `);

    await mkdir(appDir, { recursive: true });
    await mkdir(join(renderersDir, "gl"), { recursive: true });
    await mkdir(join(renderersDir, "shared", "system"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pixi-like",
        types: "index.d.ts"
      }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export * from "./app/Application";
        export * from "./rendering/RenderingMixins";
      `,
      "utf8"
    );
    await writeFile(
      join(appDir, "Application.d.ts"),
      dedent`
        import type { AutoDetectOptions } from "../rendering/renderers/autoDetectRenderer";

        export interface ApplicationOptions extends AutoDetectOptions, PixiMixins.ApplicationOptions {
        }

        export declare class Application {
          init(options?: Partial<ApplicationOptions>): Promise<void>;
        }
      `,
      "utf8"
    );
    await writeFile(
      join(renderingDir, "RenderingMixins.d.ts"),
      dedent`
        declare global {
          namespace PixiMixins {
            interface ApplicationOptions {
            }

            interface RendererOptions {
              width?: number;
            }

            interface WebGLOptions {
            }
          }
        }
      `,
      "utf8"
    );
    await writeFile(
      join(renderersDir, "autoDetectRenderer.d.ts"),
      dedent`
        import type { RendererOptions } from "./types";

        export interface AutoDetectOptions extends RendererOptions {
          preference?: "webgl" | "webgpu" | "canvas";
        }
      `,
      "utf8"
    );
    await writeFile(
      join(renderersDir, "types.d.ts"),
      dedent`
        import type { WebGLOptions } from "./gl/WebGLRenderer";

        export interface RendererOptions extends WebGLOptions {
        }
      `,
      "utf8"
    );
    await writeFile(
      join(renderersDir, "gl", "WebGLRenderer.d.ts"),
      dedent`
        import type { SharedRendererOptions } from "../shared/system/SharedSystems";

        export interface WebGLOptions extends SharedRendererOptions, PixiMixins.WebGLOptions {
        }
      `,
      "utf8"
    );
    await writeFile(
      join(renderersDir, "shared", "system", "SharedSystems.d.ts"),
      dedent`
        export type ExtractRendererOptions<T> = ViewSystemOptions;

        export interface ViewSystemOptions {
          antialias?: boolean;
        }

        export interface SharedRendererOptions extends ExtractRendererOptions<typeof SharedSystems>, PixiMixins.RendererOptions {
          skipExtensionImports?: boolean;
        }

        export declare const SharedSystems: unknown[];
      `,
      "utf8"
    );
    await writeFile(mainPath, marked.source, "utf8");

    const baseSession = createAnalysisSession(marked.source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    const sharedSystemsSource = await readFile(join(renderersDir, "shared", "system", "SharedSystems.d.ts"), "utf8");
    const antialiasLine = sharedSystemsSource.split("\n").findIndex((line) => line.includes("antialias?: boolean"));
    const hover = await resolveHoverWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const location = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect((hover?.contents as { value?: string } | undefined)?.value).toContain("antialias: boolean");
    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(join(renderersDir, "shared", "system", "SharedSystems.d.ts")).toString());
    expect(location?.range.start.line).toBe(antialiasLine);
  });

  it("navigates node_modules members inherited through qualified namespace mixins", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-mixin-members-"));
    const pkgDir = join(root, "node_modules", "pixi-like");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Container } from "pixi-like"

      fun demo(stage: Container) {
        stage.addChildAt(0)
      }
    `;
    const pkgSource = dedent`
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
    `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pixi-like",
        types: "index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), pkgSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    const lines = source.split("\n");
    const pkgLines = pkgSource.split("\n");
    const memberLine = lines.findIndex((line) => line.includes("stage.addChildAt"));
    const memberCharacter = lines[memberLine]!.indexOf("addChildAt") + 2;
    const definitionLine = pkgLines.findIndex((line) => line.includes("addChildAt"));

    const definition = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: memberLine,
      character: memberCharacter,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect(definition?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(definition?.range.start.line).toBe(definitionLine);
  });

  it("resolves go-to-definition for members on node_modules union receiver types", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-union-member-nav-"));
    const pkgDir = join(root, "node_modules", "pixi-like");
    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { Application } from "pixi-like"

      val app = Application()
      app.renderer.resi^^^ze(480, 320, 1)
    `);
    const pkgSource = dedent`
      export declare class WebGLRenderer {
        resize(desiredScreenWidth: number, desiredScreenHeight: number, resolution: number): void;
      }

      export declare class WebGPURenderer {
        resize(desiredScreenWidth: number, desiredScreenHeight: number, resolution: number): void;
      }

      export declare class CanvasRenderer {
        resize(desiredScreenWidth: number, desiredScreenHeight: number, resolution: number): void;
      }

      export type Renderer = WebGLRenderer | WebGPURenderer | CanvasRenderer;

      export declare class Application {
        renderer: Renderer;
      }
    `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pixi-like",
        types: "index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), pkgSource, "utf8");
    await writeFile(mainPath, marked.source, "utf8");

    const baseSession = createAnalysisSession(marked.source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    const pkgLines = pkgSource.split("\n");
    const resizeLine = pkgLines.findIndex((line) => line.includes("resize(desiredScreenWidth"));
    const location = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(location?.range.start.line).toBe(resizeLine);
  });

  it("resolves go-to-definition for members on named-imported node_modules module objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-named-module-object-nav-"));
    const pkgDir = join(root, "node_modules", "zod");
    const libDir = join(pkgDir, "lib");
    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { z } from "zod"

      val schema = z.obj^^^ect({
        name: z.string(),
        age: z.number()
      })
    `);
    const packageSource = dedent`
      import * as z from "./external";
      export * from "./external";
      export { z };
      export default z;
    `;
    const externalSource = dedent`
      export interface ZType<Output> {
        parse(value: unknown): Output;
        _output: Output;
      }

      export interface ZString extends ZType<string> {
      }

      export interface ZNumber extends ZType<number> {
      }

      export type ZRawShape = { [key: string]: ZType<any> };
      export interface ZObject<TShape extends ZRawShape> extends ZType<any> {
        shape: TShape;
      }

      declare const stringType: () => ZString;
      declare const numberType: () => ZNumber;
      declare function objectType<TShape extends ZRawShape>(shape: TShape): ZObject<TShape>;

      export { stringType as string, numberType as number, objectType as object };
    `;

    await mkdir(libDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "zod",
        types: "./index.d.ts"
      }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      'export * from "./lib";\nexport as namespace Zod;\n',
      "utf8"
    );
    await writeFile(join(libDir, "index.d.ts"), packageSource, "utf8");
    await writeFile(join(libDir, "external.d.ts"), externalSource, "utf8");
    await writeFile(mainPath, marked.source, "utf8");

    const baseSession = createAnalysisSession(marked.source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    const externalLines = externalSource.split("\n");
    const objectLine = externalLines.findIndex((line) => line.includes("declare function objectType"));
    const location = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(join(libDir, "external.d.ts")).toString());
    expect(location?.range.start.line).toBe(objectLine);
  });

  it("navigates and hovers type identifiers inside node_modules qualified type aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-qualified-type-nav-"));
    const pkgDir = join(root, "node_modules", "zod");
    const libDir = join(pkgDir, "lib");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { z, defaultSchema } from "zod"

      const UserSchema = z.object({
        name: z.string(),
        age: z.number()
      })

      type User = z.infer<typeof UserSchema>
      type ImportedSchema = typeof defaultSchema

      fun issueMessage(issue: z.core.Issue): string {
        return issue.message
      }
    `;
    const inferMarked = sourceWithCursor(source.replace("z.infer", "z.in^^^fer"));
    const namespaceMarked = sourceWithCursor(source.replace("import { z,", "import { z^^^,"));
    const schemaMarked = sourceWithCursor(source.replace("typeof UserSchema", "typeof Us^^^erSchema"));
    const importedSchemaMarked = sourceWithCursor(source.replace("typeof defaultSchema", "typeof defaultSc^^^hema"));
    const issueTypeMarked = sourceWithCursor(source.replace("z.core.Issue", "z.core.Is^^^sue"));
    const issueMessageMarked = sourceWithCursor(source.replace("issue.message", "issue.mes^^^sage"));
    const packageSource = dedent`
      import * as z from "./external";
      export * from "./external";
      export { z };
      export default z;
    `;
    const externalSource = dedent`
      export * as core from "./errors";

      export interface ZType<Output> {
        parse(value: unknown): Output;
        _output: Output;
      }

      export interface ZString extends ZType<string> {
      }

      export interface ZNumber extends ZType<number> {
      }

      export type ZRawShape = { [key: string]: ZType<any> };
      export interface ZObject<TShape extends ZRawShape> extends ZType<any> {
        shape: TShape;
      }
      export declare type TypeOf<T extends ZType<any>> = T["_output"];
      export type { TypeOf as infer };

      declare const stringType: () => ZString;
      declare const numberType: () => ZNumber;
      declare function objectType<TShape extends ZRawShape>(shape: TShape): ZObject<TShape>;
      export declare const defaultSchema: ZObject<{ title: ZString }>;

      export { stringType as string, numberType as number, objectType as object };
    `;
    const errorsSource = dedent`
      export interface IssueBase {
        readonly message: string;
      }
      export interface IssueA extends IssueBase {
        readonly code: "a";
      }
      export interface IssueB extends IssueBase {
        readonly code: "b";
      }
      export type Issue = IssueA | IssueB;
    `;

    await mkdir(libDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "zod",
        types: "./index.d.ts"
      }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      'export * from "./lib";\nexport as namespace Zod;\n',
      "utf8"
    );
    await writeFile(join(libDir, "index.d.ts"), packageSource, "utf8");
    await writeFile(join(libDir, "external.d.ts"), externalSource, "utf8");
    await writeFile(join(libDir, "errors.d.ts"), errorsSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(source, {
      externalDeclarations: collected.externalDeclarations,
      importedSymbols: collected.importedSymbols,
      invalidImportedBindings: collected.invalidImportedBindings
    });

    const externalLines = externalSource.split("\n");
    const inferLine = externalLines.findIndex((line) => line.includes("declare type TypeOf"));
    const defaultSchemaLine = externalLines.findIndex((line) => line.includes("defaultSchema"));
    const schemaLine = source.split("\n").findIndex((line) => line.includes("const UserSchema"));
    const context = {
      uri: pathToFileURL(mainPath).toString(),
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    };

    const inferLocation = await resolveDefinitionWithLocalFallback({
      ...context,
      line: inferMarked.line,
      character: inferMarked.character
    });
    const namespaceLocation = await resolveDefinitionWithLocalFallback({
      ...context,
      line: namespaceMarked.line,
      character: namespaceMarked.character
    });
    const inferHover = await resolveHoverWithLocalFallback({
      ...context,
      line: inferMarked.line,
      character: inferMarked.character
    });
    const schemaLocation = await resolveDefinitionWithLocalFallback({
      ...context,
      line: schemaMarked.line,
      character: schemaMarked.character
    });
    const schemaHover = await resolveHoverWithLocalFallback({
      ...context,
      line: schemaMarked.line,
      character: schemaMarked.character
    });
    const importedSchemaLocation = await resolveDefinitionWithLocalFallback({
      ...context,
      line: importedSchemaMarked.line,
      character: importedSchemaMarked.character
    });
    const importedSchemaHover = await resolveHoverWithLocalFallback({
      ...context,
      line: importedSchemaMarked.line,
      character: importedSchemaMarked.character
    });
    const issueTypeLocation = await resolveDefinitionWithLocalFallback({
      ...context,
      line: issueTypeMarked.line,
      character: issueTypeMarked.character
    });
    const issueTypeHover = await resolveHoverWithLocalFallback({
      ...context,
      line: issueTypeMarked.line,
      character: issueTypeMarked.character
    });
    const issueMessageLocation = await resolveDefinitionWithLocalFallback({
      ...context,
      line: issueMessageMarked.line,
      character: issueMessageMarked.character
    });

    expect(inferLocation?.uri).toBe(pathToFileURL(join(libDir, "external.d.ts")).toString());
    expect(inferLocation?.range.start.line).toBe(inferLine);
    expect(inferHover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\ntype z.infer\n```"
    });
    expect(namespaceLocation?.uri).toBe(pathToFileURL(join(libDir, "index.d.ts")).toString());
    expect(namespaceLocation?.range.start.line).toBe(0);
    expect(namespaceLocation?.range.start.character).toBe("import * as ".length);
    expect(schemaLocation?.uri).toBe(pathToFileURL(mainPath).toString());
    expect(schemaLocation?.range.start.line).toBe(schemaLine);
    expect(schemaHover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\nvariable UserSchema: ZObject<{\n  name: ZString;\n  age: ZNumber;\n}>\n```"
    });
    expect(importedSchemaLocation?.uri).toBe(pathToFileURL(join(libDir, "external.d.ts")).toString());
    expect(importedSchemaLocation?.range.start.line).toBe(defaultSchemaLine);
    expect(importedSchemaHover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\nvariable defaultSchema: ZObject<{\n  title: ZString;\n}>\n```"
    });
    expect(issueTypeLocation?.uri).toBe(pathToFileURL(join(libDir, "errors.d.ts")).toString());
    expect(issueTypeLocation?.range.start.line).toBe(9);
    expect(issueTypeHover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\ntype z.core.Issue\n```"
    });
    expect(issueMessageLocation?.uri).toBe(pathToFileURL(join(libDir, "errors.d.ts")).toString());
    expect(issueMessageLocation?.range.start.line).toBe(1);
  });

  it("navigates default imports used inside node_modules type queries", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-default-typeof-nav-"));
    const pkgDir = join(root, "node_modules", "shape-kit");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import defaultSchema from "shape-kit"

      type SchemaCopy = typeof defaultSchema
    `;
    const marked = sourceWithCursor(source.replace("typeof defaultSchema", "typeof defaultSc^^^hema"));
    const packageSource = dedent`
      export interface Schema {
        title: string;
      }

      export default function defaultSchema(): Schema;
    `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "shape-kit",
        types: "./index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), packageSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(source, {
      externalDeclarations: collected.externalDeclarations,
      importedSymbols: collected.importedSymbols,
      invalidImportedBindings: collected.invalidImportedBindings
    });
    const context = {
      uri: pathToFileURL(mainPath).toString(),
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    };
    const packageLines = packageSource.split("\n");
    const defaultLine = packageLines.findIndex((line) => line.includes("defaultSchema"));

    const location = await resolveDefinitionWithLocalFallback({
      ...context,
      line: marked.line,
      character: marked.character
    });
    const hover = await resolveHoverWithLocalFallback({
      ...context,
      line: marked.line,
      character: marked.character
    });

    expect(location?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(location?.range.start.line).toBe(defaultLine);
    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\nfunction defaultSchema: () => Schema\n```"
    });
  });

  it("navigates import type members from node_modules type queries", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-import-type-nav-"));
    const pkgDir = join(root, "node_modules", "shape-kit");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      type ExternalSchema = import("shape-kit").Schema
      type SchemaFactory = typeof import("shape-kit").defaultSchema
      type DefaultSchemaFactory = typeof import("shape-kit").default
      type ImportedUser = import("shape-kit").Models.User
    `;
    const schemaMarked = sourceWithCursor(source.replace(".Schema", ".Sch^^^ema"));
    const defaultSchemaMarked = sourceWithCursor(source.replace(".defaultSchema", ".defaultSc^^^hema"));
    const defaultExportMarked = sourceWithCursor(source.replace(
      'type DefaultSchemaFactory = typeof import("shape-kit").default',
      'type DefaultSchemaFactory = typeof import("shape-kit").def^^^ault'
    ));
    const namespaceMarked = sourceWithCursor(source.replace(".Models", ".Mod^^^els"));
    const nestedUserMarked = sourceWithCursor(source.replace(".User", ".Us^^^er"));
    const packageSource = dedent`
      export interface Schema {
        title: string;
      }

      export declare const defaultSchema: () => Schema;
      export default function createSchema(): Schema;
      export namespace Models {
        export interface User {
          name: string;
        }
      }
    `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "shape-kit",
        types: "./index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), packageSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(source, {
      externalDeclarations: collected.externalDeclarations,
      importedSymbols: collected.importedSymbols,
      invalidImportedBindings: collected.invalidImportedBindings
    });
    const context = {
      uri: pathToFileURL(mainPath).toString(),
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    };
    const packageLines = packageSource.split("\n");
    const schemaLine = packageLines.findIndex((line) => line.includes("interface Schema"));
    const defaultSchemaLine = packageLines.findIndex((line) => line.includes("defaultSchema"));
    const defaultExportLine = packageLines.findIndex((line) => line.includes("createSchema"));
    const namespaceLine = packageLines.findIndex((line) => line.includes("namespace Models"));
    const nestedUserLine = packageLines.findIndex((line) => line.includes("interface User"));

    const schemaLocation = await resolveDefinitionWithLocalFallback({
      ...context,
      line: schemaMarked.line,
      character: schemaMarked.character
    });
    const schemaHover = await resolveHoverWithLocalFallback({
      ...context,
      line: schemaMarked.line,
      character: schemaMarked.character
    });
    const defaultSchemaLocation = await resolveDefinitionWithLocalFallback({
      ...context,
      line: defaultSchemaMarked.line,
      character: defaultSchemaMarked.character
    });
    const defaultSchemaHover = await resolveHoverWithLocalFallback({
      ...context,
      line: defaultSchemaMarked.line,
      character: defaultSchemaMarked.character
    });
    const defaultExportLocation = await resolveDefinitionWithLocalFallback({
      ...context,
      line: defaultExportMarked.line,
      character: defaultExportMarked.character
    });
    const defaultExportHover = await resolveHoverWithLocalFallback({
      ...context,
      line: defaultExportMarked.line,
      character: defaultExportMarked.character
    });
    const namespaceLocation = await resolveDefinitionWithLocalFallback({
      ...context,
      line: namespaceMarked.line,
      character: namespaceMarked.character
    });
    const namespaceHover = await resolveHoverWithLocalFallback({
      ...context,
      line: namespaceMarked.line,
      character: namespaceMarked.character
    });
    const nestedUserLocation = await resolveDefinitionWithLocalFallback({
      ...context,
      line: nestedUserMarked.line,
      character: nestedUserMarked.character
    });
    const nestedUserHover = await resolveHoverWithLocalFallback({
      ...context,
      line: nestedUserMarked.line,
      character: nestedUserMarked.character
    });

    expect(schemaLocation?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(schemaLocation?.range.start.line).toBe(schemaLine);
    expect(schemaHover?.contents).toEqual({
      kind: "markdown",
      value: '```typescript\ntype import("shape-kit").Schema\n```'
    });
    expect(defaultSchemaLocation?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(defaultSchemaLocation?.range.start.line).toBe(defaultSchemaLine);
    expect(defaultSchemaHover?.contents).toEqual({
      kind: "markdown",
      value: '```typescript\ntype import("shape-kit").defaultSchema\n```'
    });
    expect(defaultExportLocation?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(defaultExportLocation?.range.start.line).toBe(defaultExportLine);
    expect(defaultExportHover?.contents).toEqual({
      kind: "markdown",
      value: '```typescript\ntype import("shape-kit").default\n```'
    });
    expect(namespaceLocation?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(namespaceLocation?.range.start.line).toBe(namespaceLine);
    expect(namespaceHover?.contents).toEqual({
      kind: "markdown",
      value: '```typescript\ntype import("shape-kit").Models\n```'
    });
    expect(nestedUserLocation?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(nestedUserLocation?.range.start.line).toBe(nestedUserLine);
    expect(nestedUserHover?.contents).toEqual({
      kind: "markdown",
      value: '```typescript\ntype import("shape-kit").Models.User\n```'
    });
  });

  it("navigates import type members through export-star namespace reexports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-import-namespace-reexport-nav-"));
    const pkgDir = join(root, "node_modules", "shape-kit");
    const mainPath = join(root, "main.vx");
    const source = 'type ImportedUser = import("shape-kit").Models.Us^^^er\n';
    const marked = sourceWithCursor(source);
    const modelsSource = dedent`
      export interface User {
        name: string;
      }
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
    await writeFile(join(pkgDir, "src", "models.d.ts"), modelsSource, "utf8");
    await writeFile(mainPath, marked.source, "utf8");

    const session = createAnalysisSession(marked.source);
    const context = {
      uri: pathToFileURL(mainPath).toString(),
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    };

    const location = await resolveDefinitionWithLocalFallback({
      ...context,
      line: marked.line,
      character: marked.character
    });
    const hover = await resolveHoverWithLocalFallback({
      ...context,
      line: marked.line,
      character: marked.character
    });

    expect(location?.uri).toBe(pathToFileURL(join(pkgDir, "src", "models.d.ts")).toString());
    expect(location?.range.start.line).toBe(0);
    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: '```typescript\ntype import("shape-kit").Models.User\n```'
    });
  });

  it("navigates import type default reexports to the source declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-import-default-reexport-nav-"));
    const pkgDir = join(root, "node_modules", "shape-kit");
    const mainPath = join(root, "main.vx");
    const source = 'type SchemaFactory = typeof import("shape-kit").def^^^ault\n';
    const marked = sourceWithCursor(source);
    const factorySource = dedent`
      export interface Schema {
        title: string;
      }

      export function createSchema(): Schema;
    `;

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
    await writeFile(join(pkgDir, "factory.d.ts"), factorySource, "utf8");
    await writeFile(mainPath, marked.source, "utf8");

    const session = createAnalysisSession(marked.source);
    const context = {
      uri: pathToFileURL(mainPath).toString(),
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    };
    const sourceLine = factorySource.split("\n").findIndex((line) => line.includes("createSchema"));

    const location = await resolveDefinitionWithLocalFallback({
      ...context,
      line: marked.line,
      character: marked.character
    });
    const hover = await resolveHoverWithLocalFallback({
      ...context,
      line: marked.line,
      character: marked.character
    });

    expect(location?.uri).toBe(pathToFileURL(join(pkgDir, "factory.d.ts")).toString());
    expect(location?.range.start.line).toBe(sourceLine);
    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: '```typescript\ntype import("shape-kit").default\n```'
    });
  });

  it("resolves inherited node_modules accessor members to their base declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-accessor-member-nav-"));
    const pkgDir = join(root, "node_modules", "pixi-like");
    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { Text } from "pixi-like"

      val label = Text()
      label.te^^^xt = "Hello"
    `);
    const pkgSource = dedent`
      export type TextString = string | number;

      export declare abstract class AbstractText {
        set text(value: TextString);
        get text(): string;
      }

      export interface Text extends AbstractText {
      }

      export declare class Text extends AbstractText {
        constructor();
      }
    `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pixi-like",
        types: "index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), pkgSource, "utf8");
    await writeFile(mainPath, marked.source, "utf8");

    const baseSession = createAnalysisSession(marked.source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    const pkgLines = pkgSource.split("\n");
    const textLine = pkgLines.findIndex((line) => line.includes("set text(value: TextString);"));
    const hover = await resolveHoverWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const location = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect((hover?.contents as { value?: string } | undefined)?.value).toContain("text:");
    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(location?.range.start.line).toBe(textLine);
  });

  it("resolves node_modules inherited members through export-star barrels to the original declaration file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-barrel-member-nav-"));
    const pkgDir = join(root, "node_modules", "pixi-like");
    const textDir = join(pkgDir, "scene", "text");
    const mainPath = join(root, "main.vx");
    const marked = sourceWithCursor(dedent`
      import { Text } from "pixi-like"

      val label = Text()
      label.te^^^xt = "Hello"
    `);
    const indexSource = dedent`
      export * from "./scene/text/Text";
    `;
    const textSource = dedent`
      import { AbstractText, type TextString } from "./AbstractText";

      export interface Text extends AbstractText {
      }

      export declare class Text extends AbstractText {
        constructor();
      }
    `;
    const abstractTextSource = dedent`
      export type TextString = string | number;

      export declare abstract class AbstractText {
        set text(value: TextString);
        get text(): string;
      }
    `;

    await mkdir(textDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pixi-like",
        types: "index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), indexSource, "utf8");
    await writeFile(join(textDir, "Text.d.ts"), textSource, "utf8");
    await writeFile(join(textDir, "AbstractText.d.ts"), abstractTextSource, "utf8");
    await writeFile(mainPath, marked.source, "utf8");

    const baseSession = createAnalysisSession(marked.source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    const abstractLines = abstractTextSource.split("\n");
    const textLine = abstractLines.findIndex((line) => line.includes("set text(value: TextString);"));
    const location = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(join(textDir, "AbstractText.d.ts")).toString());
    expect(location?.range.start.line).toBe(textLine);
  });

  it("resolves go-to-definition from member access to class member declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.x\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 3,
      character: 8,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(fileA).toString(),
      range: {
        start: { line: 0, character: 20 },
        end: { line: 0, character: 21 }
      }
    });
  });

  it("keeps go-to-definition for a non-static member accessed through an imported class", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-non-static-member-"));
    const boxFile = join(root, "Box3.vx");
    const mainFile = join(root, "main.vx");
    const declared = sourceWithCursor(dedent`
      export class Box3 {
        static create(): Box3 { return new Box3() }
        clo^^^ne(): Box3 { return this }
      }
    `);
    const used = sourceWithCursor(dedent`
      import { Box3 } from "./Box3.vx"

      Box3.clo^^^ne()
    `);
    await writeFile(boxFile, declared.source, "utf8");
    await writeFile(mainFile, used.source, "utf8");

    const boxSession = createAnalysisSession(declared.source);
    const baseSession = createAnalysisSession(used.source);
    const getSessionForFilePath = (filePath: string) => {
      if (filePath === boxFile) return boxSession;
      return null;
    };
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainFile).href,
      sourceRoots: [root],
      getSessionForFilePath
    });
    const session = createAnalysisSession(used.source, {
      externalDeclarations: collected.externalDeclarations,
      externalDeclarationLocations: collected.externalDeclarationLocations,
      importedSymbols: collected.importedSymbols,
      invalidImportedBindings: collected.invalidImportedBindings
    });

    expect(session.semanticIssues.map((issue) => issue.message)).toContain(
      "Member 'clone' is not static and cannot be accessed on class 'Box3'"
    );

    const location = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainFile).href,
      line: used.line,
      character: used.character,
      session,
      sourceRoots: [root],
      getSessionForFilePath
    });

    expect(location).toEqual({
      uri: pathToFileURL(boxFile).href,
      range: {
        start: { line: declared.line, character: declared.character - "clo".length },
        end: { line: declared.line, character: declared.character + "ne".length }
      }
    });
  });

  it("resolves go-to-definition from operator usage to the operator declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "point.vx");

    const source = dedent`
      class Point(val x: number, val y: number) {
        operator+(other: Point): Point {
          return new Point(this.x + other.x, this.y + other.y)
        }
      }
      fun demo() {
        let p = new Point(1, 2)
        let q = new Point(3, 4)
        let r = p + q
      }
      `;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 8,
      character: 12,
      session,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(file).toString(),
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 11 }
      }
    });
  });

  it("resolves go-to-definition from a cross-file operator usage to the imported declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const other = join(root, "other.vx");
    const main = join(root, "main.vx");

    const otherSource = dedent`
      class Point(val x: number, val y: number)
      fun Point.operator+(other: Point) => Point(x + other.x, y + other.y)
      `;
    const mainSource =
      'import { Point, operator+ } from "./other"\n' +
      "const sum = Point(1, 2) + Point(3, 4)\n";

    await writeFile(other, otherSource, "utf8");
    await writeFile(main, mainSource, "utf8");

    const uri = pathToFileURL(main).toString();
    const baseSession = createAnalysisSession(mainSource);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri,
      sourceRoots: [root]
    });
    const session = createAnalysisSession(mainSource, { externalDeclarations: externalDeclarations });

    // Cursor on the `+` operator of `Point(1, 2) + Point(3, 4)`.
    const location = await resolveDefinitionAcrossFiles({
      uri,
      line: 1,
      character: mainSource.split("\n")[1]!.indexOf(") + ") + 2,
      session,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(other).toString(),
      range: {
        start: { line: 1, character: 10 },
        end: { line: 1, character: 19 }
      }
    });
  });

  it("resolves go-to-definition from a cross-file extension property usage to the imported declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const other = join(root, "other.vx");
    const main = join(root, "main.vx");

    const otherSource = dedent`
      class TimeSpan(val ms: number)
      val number.seconds: TimeSpan => TimeSpan(this * 1000.0)
      `;
    const mainSource =
      'import { TimeSpan, seconds } from "./other"\n' +
      "const span = 1.seconds\n";

    await writeFile(other, otherSource, "utf8");
    await writeFile(main, mainSource, "utf8");

    const uri = pathToFileURL(main).toString();
    const baseSession = createAnalysisSession(mainSource);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri,
      sourceRoots: [root]
    });
    const session = createAnalysisSession(mainSource, { externalDeclarations: externalDeclarations });

    // Cursor on `seconds` in `1.seconds`.
    const location = await resolveDefinitionAcrossFiles({
      uri,
      line: 1,
      character: mainSource.split("\n")[1]!.indexOf(".seconds") + 2,
      session,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(other).toString(),
      range: {
        start: { line: 1, character: 11 },
        end: { line: 1, character: 18 }
      }
    });
  });

  it("resolves inherited imported receiver extension properties and hovers them", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const lib = join(root, "lib.vx");
    const main = join(root, "main.vx");

    const libSource = dedent`
      export class View(var x: number, var y: number)
      export class Graphics extends View
    `;
    const marked = sourceWithCursor(dedent`
      import { View, Graphics } from "./lib"

      class Vec2(val x: number, val y: number)

      /// World-space point.
      var View.point: Vec2 {
        get => Vec2(x, y)
      }

      val badge = Graphics(1, 2)
      badge.^^^point
    `);

    await writeFile(lib, libSource, "utf8");
    await writeFile(main, marked.source, "utf8");

    const uri = pathToFileURL(main).toString();
    const baseSession = createAnalysisSession(marked.source);
    const resolved = await collectAllImportedDeclarations(baseSession.ast!, {
      uri,
      sourceRoots: [root]
    });
    const session = createAnalysisSession(marked.source, { externalDeclarations: resolved.externalDeclarations, importedSymbols: resolved.importedSymbols });

    const location = await resolveDefinitionWithLocalFallback({
      uri,
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root]
    });
    const hover = await resolveHoverWithLocalFallback({
      uri,
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root]
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(uri);
    expect(location?.range.start.line).toBe(5);
    expect(location?.range.start.character).toBe(9);
    expect((hover?.contents as { value?: string } | undefined)?.value).toContain("point: Vec2");
    expect((hover?.contents as { value?: string } | undefined)?.value).toContain("World-space point.");
  });

  it("resolves go-to-definition from a cross-file extension method usage to the imported declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const other = join(root, "other.vx");
    const main = join(root, "main.vx");

    const otherSource = dedent`
      class Point(val x: number, val y: number)
      fun Point.magnitude(): number => x
      `;
    const mainSource =
      'import { Point, magnitude } from "./other"\n' +
      "const m = Point(1, 2).magnitude()\n";

    await writeFile(other, otherSource, "utf8");
    await writeFile(main, mainSource, "utf8");

    const uri = pathToFileURL(main).toString();
    const baseSession = createAnalysisSession(mainSource);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri,
      sourceRoots: [root]
    });
    const session = createAnalysisSession(mainSource, { externalDeclarations: externalDeclarations });

    // Cursor on `magnitude` in `Point(1, 2).magnitude()`.
    const location = await resolveDefinitionAcrossFiles({
      uri,
      line: 1,
      character: mainSource.split("\n")[1]!.indexOf(".magnitude") + 2,
      session,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(other).toString(),
      range: {
        start: { line: 1, character: 10 },
        end: { line: 1, character: 19 }
      }
    });
  });

  it("resolves go-to-definition from a chain extension method usage to the imported declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const other = join(root, "utils.vx");
    const main = join(root, "main.vx");

    const otherSource = dedent`
      class View {}
      class Graphics extends View {}
      class Container<T> {}
      var View.point: number {
        get { return 0 }
        set { }
      }
      fun View.addTo(container: Container<any>) {}
      `;
    const mainSource =
      'import { Graphics, Container, point, addTo } from "./utils"\n' +
      "const stage = Container<any>()\n" +
      "const view = Graphics()\n" +
      "  ..point = 1\n" +
      "  ..addTo(stage)\n";

    await writeFile(other, otherSource, "utf8");
    await writeFile(main, mainSource, "utf8");

    const uri = pathToFileURL(main).toString();
    const baseSession = createAnalysisSession(mainSource);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => filePath === other ? createAnalysisSession(otherSource) : null
    });
    const session = createAnalysisSession(mainSource, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    const lines = mainSource.split("\n");
    const pointLine = lines[3]!;
    const addToLine = lines[4]!;
    const pointLocation = await resolveDefinitionAcrossFiles({
      uri,
      line: 3,
      character: pointLine.indexOf("point") + "point".length,
      session,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => filePath === other ? createAnalysisSession(otherSource) : null
    });
    const location = await resolveDefinitionAcrossFiles({
      uri,
      line: 4,
      character: addToLine.indexOf("addTo") + 1,
      session,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => filePath === other ? createAnalysisSession(otherSource) : null
    });
    const locationAtTokenEnd = await resolveDefinitionAcrossFiles({
      uri,
      line: 4,
      character: addToLine.indexOf("addTo") + "addTo".length,
      session,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => filePath === other ? createAnalysisSession(otherSource) : null
    });

    const expectedLocation = {
      uri: pathToFileURL(other).toString(),
      range: {
        start: { line: 7, character: 9 },
        end: { line: 7, character: 14 }
      }
    };
    expect(pointLocation).toEqual({
      uri: pathToFileURL(other).toString(),
      range: {
        start: { line: 3, character: 9 },
        end: { line: 3, character: 14 }
      }
    });
    expect(location).toEqual(expectedLocation);
    expect(locationAtTokenEnd).toEqual(expectedLocation);
  });

  it("provides hover info for primary constructor members", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "world.vx");
    const source = "class MyPoint(const x: number, const y: number) { }\n";

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 0,
      character: 20,
      session,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\nx: number\n```"
    });
    expect(hover?.range).toEqual({
      start: { line: 0, character: 20 },
      end: { line: 0, character: 21 }
    });
  });

  it("provides hover info for imported class member access", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.y\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 3,
      character: 8,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\ny: number\n```"
    });
    expect(hover?.range).toEqual({
      start: { line: 3, character: 8 },
      end: { line: 3, character: 9 }
    });
  });

  it("infers hover info for getter shorthand class properties", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "main.vx");
    const source = dedent`
      class Adler32 {
        private checksum = 1i
        value => checksum
      }
      val adler = Adler32()
      adler.value
      `;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 5,
      character: 8,
      session,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\nvalue: int\n```"
    });
  });

  it("resolves hover and definition for boxed Number members on int receivers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "main.vx");
    const source = dedent`
      class Adler32 {
        private checksum = 1
        value => checksum
      }
      val adler = Adler32()
      adler.value.valueOf()
      `;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const definition = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 5,
      character: source.split("\n")[5]!.indexOf("valueOf") + 1,
      session,
      sourceRoots: [root]
    });
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 5,
      character: source.split("\n")[5]!.indexOf("valueOf") + 1,
      session,
      sourceRoots: [root]
    });

    expect(definition?.uri).toBe(pathToFileURL(await getEcmaScriptRuntimeDeclarationFilePath()).toString());
    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\nvalueOf: () => number\n```\n\nReturns the primitive value of the specified object."
    });
  });

  it("resolves definition and hover for imported object type alias members", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const scenariosPath = join(root, "scenarios.vx");
    const mainPath = join(root, "main.vx");

    const scenariosSource = dedent`
      export type Scenario = {
        label: string,
        source: string,
        showTree?: boolean
      }
    `;
    const mainSource = dedent`
      import { Scenario } from "./scenarios.vx"
      function lex(source: string) {}
      function summarizeScenario(scenario: Scenario): string {
        const tokens = lex(scenario.source)
      }
    `;

    await writeFile(scenariosPath, scenariosSource, "utf8");
    await writeFile(mainPath, mainSource, "utf8");

    const baseSession = createAnalysisSession(mainSource);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(mainSource, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    const definition = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".source") + 2,
      session,
      sourceRoots: [root]
    });
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".source") + 2,
      session,
      sourceRoots: [root]
    });

    expect(definition).toEqual({
      uri: pathToFileURL(scenariosPath).toString(),
      range: {
        start: { line: 2, character: 2 },
        end: { line: 2, character: 8 }
      }
    });
    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\nsource: string\n```"
    });
  });

  it("resolves definition and hover for imported class members after an 'is' smart-cast", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-smart-cast-"));
    const astPath = join(root, "ast.vx");
    const mainPath = join(root, "optimizer.vx");
    const astSource = dedent`
      export class NumberExpr(val value: number) {
        readonly kind = "number"
      }
      export class UnaryExpr(val operator: string, val operand: NumberExpr | UnaryExpr) {
        readonly kind = "unary"
      }
    `;
    const mainSource = dedent`
      import { NumberExpr, UnaryExpr } from "./ast.vx"
      export function foldConstants(expression: NumberExpr | UnaryExpr): NumberExpr | UnaryExpr {
        if (expression is UnaryExpr) {
          expression.operator
        }
        return expression
      }
    `;

    await writeFile(astPath, astSource, "utf8");
    await writeFile(mainPath, mainSource, "utf8");

    const baseSession = createAnalysisSession(mainSource);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(mainSource, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    const definition = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".operator") + 2,
      session,
      sourceRoots: [root]
    });
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".operator") + 2,
      session,
      sourceRoots: [root]
    });

    expect(definition).toEqual({
      uri: pathToFileURL(astPath).toString(),
      range: {
        start: { line: 3, character: 27 },
        end: { line: 3, character: 35 }
      }
    });
    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\noperator: string\n```"
    });
  });

  it("resolves definition and hover for imported class members after an 'instanceof' smart-cast", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-smart-cast-instanceof-"));
    const astPath = join(root, "ast.vx");
    const mainPath = join(root, "optimizer.vx");
    const astSource = dedent`
      export class NumberExpr(val value: number) {
        readonly kind = "number"
      }
      export class UnaryExpr(val operator: string, val operand: NumberExpr | UnaryExpr) {
        readonly kind = "unary"
      }
    `;
    const mainSource = dedent`
      import { NumberExpr, UnaryExpr } from "./ast.vx"
      export function foldConstants(expression: NumberExpr | UnaryExpr): NumberExpr | UnaryExpr {
        if (expression instanceof UnaryExpr) {
          expression.operator
        }
        return expression
      }
    `;

    await writeFile(astPath, astSource, "utf8");
    await writeFile(mainPath, mainSource, "utf8");

    const baseSession = createAnalysisSession(mainSource);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(mainSource, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    const definition = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".operator") + 2,
      session,
      sourceRoots: [root]
    });
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".operator") + 2,
      session,
      sourceRoots: [root]
    });

    expect(definition).toEqual({
      uri: pathToFileURL(astPath).toString(),
      range: {
        start: { line: 3, character: 27 },
        end: { line: 3, character: 35 }
      }
    });
    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\noperator: string\n```"
    });
  });

  it("resolves DOM type and member definitions from tsconfig lib declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-dom-"));
    const file = join(root, "main.vx");
    const source = dedent`
      fun createDocument(): Document => document
      const root: HTMLElement = createDocument().createElement("main")
      root.className
    `;
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    await writeFile(file, source, "utf8");

    const ambientDeclarations = (await ensureDomProgram()).body;
    const session = createAnalysisSession(source, { ambientDeclarations: ambientDeclarations });

    const typeDefinition = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 1,
      character: 14,
      session,
      sourceRoots: [root]
    });
    const memberDefinition = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 2,
      character: 9,
      session,
      sourceRoots: [root]
    });
    const memberHover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 2,
      character: 9,
      session,
      sourceRoots: [root]
    });

    expect(typeDefinition?.uri).toBe(pathToFileURL(getDomDeclarationFilePath()).toString());
    expect(memberDefinition?.uri).toBe(pathToFileURL(getDomDeclarationFilePath()).toString());
    expect(memberHover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\nclassName: string\n```\n\nThe **string** property of the of the specified element.\n\n[MDN Reference](https://developer.mozilla.org/docs/Web/API/Element/className)"
    });
  });

  it("resolves project global type definitions to their source file before DOM declarations", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Test {
        var color: Col^^^or
      }
    `);
    const runtimeFilePath = "/runtime/myengine-runtime.vx";
    const runtimeDeclarations = parseSource('class Color(var value: string = "#ffffff")').ast?.body ?? [];
    const domDeclarations = (await ensureDomProgram()).body;
    const globalDeclarationLocations = new Map(runtimeDeclarations.map((statement) => [
      statement,
      {
        filePath: runtimeFilePath,
        line: statement.firstToken?.range.start.line ?? 0,
        character: statement.firstToken?.range.start.column ?? 0
      }
    ] as const));
    const session = createAnalysisSession(source, {
      ambientDeclarations: [...runtimeDeclarations, ...domDeclarations],
      ambientDeclarationLocations: globalDeclarationLocations
    });

    const definition = await resolveDefinitionWithLocalFallback({
      uri: "file:///example/new-script.vx",
      line,
      character,
      session,
      sourceRoots: []
    });

    expect(definition?.uri).toBe(pathToFileURL(runtimeFilePath).toString());
    expect(definition?.range).toEqual({
      start: { line: 0, character: 6 },
      end: { line: 0, character: 11 }
    });
  });

  it("resolves aliased imported class member definitions through the shared declaration resolver", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = dedent`
      import { MyPoint as P } from "./world"
      fun demo() {
        const point = new P()
        point.x
      }
      `;

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 3,
      character: 8,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(fileA).toString(),
      range: {
        start: { line: 0, character: 20 },
        end: { line: 0, character: 21 }
      }
    });
  });

  it("provides specialized hover info for generic member access", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "generic.vx");
    const source = dedent`
      class Map<K, V> {
        a: K
        b: V
      }
      fun demo() {
        const map = new Map<string, int>()
        map.a
      }
      `;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 6,
      character: 7,
      session,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\na: string\n```"
    });
    expect(hover?.range).toEqual({
      start: { line: 6, character: 6 },
      end: { line: 6, character: 7 }
    });
  });

  it("provides hover info for inherited generic member access across files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = dedent`
      class Base<T> {
        value: T
      }
      class Child extends Base<string> {
      }
      `;
    const sourceB = dedent`
      import { Child } from "./world"
      fun demo() {
        const child = new Child()
        child.value
      }
      `;

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 3,
      character: 8,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\nvalue: string\n```"
    });
    expect(hover?.range).toEqual({
      start: { line: 3, character: 8 },
      end: { line: 3, character: 13 }
    });
  });

  it("includes triple-slash documentation in cross-file member hover", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = dedent`
      class Point {
        /// The x coordinate.
        x: number
        /// The y coordinate.
        y: number
      }
      `;
    const sourceB = dedent`
      import { Point } from "./world"
      fun demo() {
        const point = new Point()
        point.x
      }
      `;

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 3,
      character: 8,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\nx: number\n```\n\nThe x coordinate."
    });
  });

  it("finds references across importer files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");
    const fileC = join(root, "c.vx");

    const sourceA = "class Point\n";
    const sourceB = "import { Point } from \"./a\"\nfun first() {\n  return new Point()\n}\n";
    const sourceC = "import { Point } from \"./a\"\nfun second() {\n  return new Point()\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");
    await writeFile(fileC, sourceC, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(fileB).toString(),
        line: 2,
        character: 15,
        session: sessionB,
        sourceRoots: [root]
      },
      true
    );

    expect(locations).toEqual(
      expect.arrayContaining([
        {
          uri: pathToFileURL(fileA).toString(),
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 2, character: 13 },
            end: { line: 2, character: 18 }
          }
        },
        {
          uri: pathToFileURL(fileC).toString(),
          range: {
            start: { line: 2, character: 13 },
            end: { line: 2, character: 18 }
          }
        }
      ])
    );
  });

  it("finds annotation references from the declaration position in the same file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "main.vx");
    const source = dedent`
      annotation DemoTag(val label: string)
      @DemoTag("hello")
      @DemoTag("bye")
      fun demo() {}
      `;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(file).toString(),
        line: 0,
        character: 13,
        session,
        sourceRoots: [root]
      },
      true
    );

    expect(locations).toEqual([
      {
        uri: pathToFileURL(file).toString(),
        range: {
          start: { line: 0, character: 11 },
          end: { line: 0, character: 18 }
        }
      },
      {
        uri: pathToFileURL(file).toString(),
        range: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 8 }
        }
      },
      {
        uri: pathToFileURL(file).toString(),
        range: {
          start: { line: 2, character: 1 },
          end: { line: 2, character: 8 }
        }
      }
    ]);
  });

  it("finds member references across files from usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.x\n  point.x\n  point.y\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(fileB).toString(),
        line: 3,
        character: 8,
        session: sessionB,
        sourceRoots: [root]
      },
      true
    );

    expect(locations).toEqual(
      expect.arrayContaining([
        {
          uri: pathToFileURL(fileA).toString(),
          range: {
            start: { line: 0, character: 20 },
            end: { line: 0, character: 21 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 3, character: 8 },
            end: { line: 3, character: 9 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 4, character: 8 },
            end: { line: 4, character: 9 }
          }
        }
      ])
    );
    expect(
      locations.some((location) =>
        location.uri === pathToFileURL(fileB).toString() &&
        location.range.start.line === 5 &&
        location.range.start.character === 8
      )
    ).toBe(false);
  });

  it("finds member references across files from declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.x\n  point.x\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionA = createAnalysisSession(sourceA);
    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(fileA).toString(),
        line: 0,
        character: 20,
        session: sessionA,
        sourceRoots: [root]
      },
      false
    );

    expect(locations).toEqual(
      expect.arrayContaining([
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 3, character: 8 },
            end: { line: 3, character: 9 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 4, character: 8 },
            end: { line: 4, character: 9 }
          }
        }
      ])
    );
  });

  it("finds member references for instantiated generic classes across files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = dedent`
      class Map<K, V> {
        a: K
        b: V
      }
      `;
    const sourceB = dedent`
      import { Map } from "./world"
      fun demo() {
        const map = new Map<string, int>()
        map.a
        map.a
        map.b
      }
      `;

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(fileB).toString(),
        line: 3,
        character: 7,
        session: sessionB,
        sourceRoots: [root]
      },
      true
    );

    expect(locations).toEqual(
      expect.arrayContaining([
        {
          uri: pathToFileURL(fileA).toString(),
          range: {
            start: { line: 1, character: 2 },
            end: { line: 1, character: 3 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 3, character: 6 },
            end: { line: 3, character: 7 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 4, character: 6 },
            end: { line: 4, character: 7 }
          }
        }
      ])
    );
    expect(
      locations.some((location) =>
        location.uri === pathToFileURL(fileB).toString() &&
        location.range.start.line === 5 &&
        location.range.start.character === 6
      )
    ).toBe(false);
  });

  it("renames symbol across declaration and importer usages", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint {}\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  return new MyPoint()\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const edit = await resolveRenameAcrossFiles(
      {
        uri: pathToFileURL(fileB).toString(),
        line: 2,
        character: 16,
        session: sessionB,
        sourceRoots: [root]
      },
      "Point2"
    );

    expect(edit?.changes).toEqual({
      [pathToFileURL(fileA).toString()]: [
        {
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 13 }
          },
          newText: "Point2"
        }
      ],
      [pathToFileURL(fileB).toString()]: [
        {
          range: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 16 }
          },
          newText: "Point2"
        },
        {
          range: {
            start: { line: 2, character: 13 },
            end: { line: 2, character: 20 }
          },
          newText: "Point2"
        }
      ]
    });
  });

  it("renames local function parameter symbols in the same file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "local.vx");
    const source = `fun demo(arg: number) {
  return arg + arg
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const edit = await resolveRenameAcrossFiles(
      {
        uri: pathToFileURL(file).toString(),
        line: 1,
        character: 10,
        session,
        sourceRoots: [root]
      },
      "value"
    );

    expect(edit?.changes).toEqual({
      [pathToFileURL(file).toString()]: [
        {
          range: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 12 }
          },
          newText: "value"
        },
        {
          range: {
            start: { line: 1, character: 9 },
            end: { line: 1, character: 12 }
          },
          newText: "value"
        },
        {
          range: {
            start: { line: 1, character: 15 },
            end: { line: 1, character: 18 }
          },
          newText: "value"
        }
      ]
    });
  });

  it("renames from the parameter declaration position even without extra files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "decl.vx");
    const source = `fun test3(a: string, b: int, arg3: int, arg4: int) {
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const edit = await resolveRenameAcrossFiles(
      {
        uri: pathToFileURL(file).toString(),
        line: 0,
        character: 10,
        session,
        sourceRoots: [root]
      },
      "renamed"
    );

    expect(edit?.changes).toEqual({
      [pathToFileURL(file).toString()]: [
        {
          range: {
            start: { line: 0, character: 10 },
            end: { line: 0, character: 11 }
          },
          newText: "renamed"
        }
      ]
    });
  });

  it("finds references for imported type names used in implements clauses", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");

    const sourceA = "class Base\n";
    const sourceB = dedent`
      import { Base } from "./a"
      class Child implements Base {
      }
      `;

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionA = createAnalysisSession(sourceA);
    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(fileA).toString(),
        line: 0,
        character: 7,
        session: sessionA,
        sourceRoots: [root]
      },
      true
    );

    expect(locations).toEqual(
      expect.arrayContaining([
        {
          uri: pathToFileURL(fileA).toString(),
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 10 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 13 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 1, character: 23 },
            end: { line: 1, character: 27 }
          }
        }
      ])
    );
  });

  it("renames interface declarations across imports and implements clauses", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = dedent`
      interface Readable {
        say(): int
      }
      `;
    const sourceB = dedent`
      import { Readable } from "./world"
      class Map implements Readable {
        say(): int {
          return 1
        }
      }
      `;

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionA = createAnalysisSession(sourceA);
    const edit = await resolveRenameAcrossFiles(
      {
        uri: pathToFileURL(fileA).toString(),
        line: 0,
        character: 12,
        session: sessionA,
        sourceRoots: [root]
      },
      "Speakable"
    );

    expect(edit?.changes?.[pathToFileURL(fileA).toString()]).toEqual(
      expect.arrayContaining([
        {
          range: {
            start: { line: 0, character: 10 },
            end: { line: 0, character: 18 }
          },
          newText: "Speakable"
        }
      ])
    );
    expect(edit?.changes?.[pathToFileURL(fileB).toString()]).toEqual(
      expect.arrayContaining([
        {
          range: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 17 }
          },
          newText: "Speakable"
        },
        {
          range: {
            start: { line: 1, character: 21 },
            end: { line: 1, character: 29 }
          },
          newText: "Speakable"
        }
      ])
    );
  });
  it("navigates array member definitions to the ECMAScript runtime declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "runtime.vx");
    const source = "fun demo() {\n  [1, 2].map { it * 2 }\n}\n";

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 1,
      character: 10,
      session,
      sourceRoots: [root]
    });

    const runtimeFilePath = await getEcmaScriptRuntimeDeclarationFilePath();
    expect(location?.uri).toBe(pathToFileURL(runtimeFilePath).toString());
    const runtimeLines = (await readFile(runtimeFilePath, "utf8")).split("\n");
    const lineText = runtimeLines[location?.range.start.line ?? -1] ?? "";
    expect(lineText).toContain("map");
  });

  it("resolves go-to-definition on import path string to the imported file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-path-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");

    await writeFile(fileA, "class Foo\n", "utf8");
    await writeFile(fileB, `import { Foo } from "./a"\n`, "utf8");

    const sessionB = createAnalysisSession(`import { Foo } from "./a"\n`);
    // cursor on the "./a" string (line 0, character 21 is inside the string)
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 0,
      character: 21,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(fileA).toString(),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    });
  });

  it("resolves hover on import path string shows resolved file path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-hover-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");

    await writeFile(fileA, "class Foo\n", "utf8");
    await writeFile(fileB, `import { Foo } from "./a"\n`, "utf8");

    const sessionB = createAnalysisSession(`import { Foo } from "./a"\n`);
    const hover = await resolveImportPathHover({
      uri: pathToFileURL(fileB).toString(),
      line: 0,
      character: 21,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(hover).not.toBeNull();
    expect(hover?.contents).toMatchObject({ kind: "plaintext" });
    expect((hover?.contents as { value: string }).value).toContain(fileA);
  });

  it("resolves go-to-definition from a virtual-workspace import string to the imported file", async () => {
    const mainPath = "/demo.vx";
    const pointPath = "/Point.vx";
    const mainSource = 'import { Point } from "./Point"\n';
    const pointSource = "class Point(val x: number, val y: number)\n";
    const sessions = new Map([
      [mainPath, createAnalysisSession(mainSource)],
      [pointPath, createAnalysisSession(pointSource)]
    ]);

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: mainSource.indexOf("./Point") + 2,
      session: sessions.get(mainPath)!,
      sourceRoots: [],
      getSessionForFilePath: (filePath) => sessions.get(filePath) ?? null
    });

    expect(location).toEqual({
      uri: pathToFileURL(pointPath).toString(),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    });
  });

  it("resolves imported class calls and operators in a virtual workspace", async () => {
    const mainPath = "/demo.vx";
    const pointPath = "/Point.vx";
    const pointSource = dedent`
      class Point(val x: number, val y: number) {
        operator+(other: Point): Point => Point(x + other.x, y + other.y)
      }
      `;
    const mainSource = 'import { Point, operator+ } from "./Point"\nval point = Point(1, 2) + Point(3, 4)\n';
    const pointSession = createAnalysisSession(pointSource);
    const baseSession = createAnalysisSession(mainSource);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [],
      getSessionForFilePath: (filePath) => filePath === pointPath ? pointSession : null
    });
    const mainSession = createAnalysisSession(mainSource, { externalDeclarations: externalDeclarations });

    expect(mainSession.semanticIssues.map((issue) => issue.message)).not.toContain(
      "Operator '+' is not defined for types 'unknown' and 'unknown'"
    );
    expect(mainSession.semanticIssues.map((issue) => issue.message)).not.toContain(
      "Operator '+' is not defined for types 'Point' and 'Point'"
    );

    const hover = mainSession.analysis!.getHoverAt(1, mainSource.split("\n")[1]!.indexOf(") + ") + 3);
    expect(hover?.contents).toBe("method operator+: (other: Point) => Point");

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 1,
      character: mainSource.split("\n")[1]!.indexOf("Point(1") + 1,
      session: mainSession,
      sourceRoots: [],
      getSessionForFilePath: (filePath) => filePath === pointPath ? pointSession : null
    });

    expect(location).toEqual({
      uri: pathToFileURL(pointPath).toString(),
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 11 }
      }
    });
  });

  it("resolves imported extension operators in a virtual workspace without requiring export", async () => {
    const mainPath = "/demo.vx";
    const timePath = "/time.vx";
    const timeSource = dedent`
      class TimeSpan(val ms: number)
      val number.seconds => TimeSpan(this * 1000.0)
      val number.milliseconds => TimeSpan(this)
      fun TimeSpan.operator+(other: TimeSpan): TimeSpan => TimeSpan(ms + other.ms)
      `;
    const mainSource = dedent`
      import { TimeSpan, seconds, milliseconds, operator+ } from "./time"
      val duration = 0.25.seconds + 10.milliseconds
      `;
    const timeSession = createAnalysisSession(timeSource);
    const baseSession = createAnalysisSession(mainSource);
    const context = {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [],
      getSessionForFilePath: (filePath: string) => filePath === timePath ? timeSession : null
    };
    const collected = await collectAllImportedDeclarations(baseSession.ast!, context);
    const mainSession = createAnalysisSession(mainSource, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(mainSession.semanticIssues.map((issue) => issue.message)).not.toContain(
      "Operator '+' is not defined for types 'unknown' and 'unknown'"
    );
    expect(mainSession.semanticIssues.map((issue) => issue.message)).not.toContain(
      "Operator '+' is not defined for types 'TimeSpan' and 'TimeSpan'"
    );

  });

  it("resolves exported extension properties imported from another file in a virtual workspace", async () => {
    const mainPath = "/demo.vx";
    const timePath = "/time.vx";
    const timeSource = dedent`
      export class TimeSpan(val ms: number)
      export val number.seconds => TimeSpan(this * 1000.0)
      export val number.milliseconds => TimeSpan(this)
      fun TimeSpan.operator+(other: TimeSpan): TimeSpan => TimeSpan(ms + other.ms)
      `;
    const mainSource = dedent`
      import { TimeSpan, seconds, milliseconds, operator+ } from "./time"
      val duration = 0.25.seconds + 10.milliseconds
      `;
    const timeSession = createAnalysisSession(timeSource);
    const baseSession = createAnalysisSession(mainSource);
    const context = {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [],
      getSessionForFilePath: (filePath: string) => filePath === timePath ? timeSession : null
    };
    const collected = await collectAllImportedDeclarations(baseSession.ast!, context);
    const mainSession = createAnalysisSession(mainSource, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

    expect(mainSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
    expect(mainSession.analysis!.getHoverAt(1, mainSource.split("\n")[1]!.indexOf("seconds") + 2)?.contents).toBe(
      "expression: TimeSpan"
    );
    expect(mainSession.analysis!.getHoverAt(1, mainSource.split("\n")[1]!.indexOf("milliseconds") + 2)?.contents).toBe(
      "expression: TimeSpan"
    );
  });

  it("resolves DOM member definitions to the virtual runtime model in a virtual workspace", async () => {
    const mainPath = "/src/main.vx";
    const virtualDomPath = "/runtime/dom.d.ts";
    const mainSource = 'const div = document.createElement("div")\n';
    const domProgram = await ensureDomProgram();
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const ambientDeclarations = domProgram.body;
    const mainSession = createAnalysisSession(mainSource, { ambientDeclarations: ambientDeclarations });
    const domSession = createAnalysisSession(domSource);

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: mainSource.indexOf("createElement") + 2,
      session: mainSession,
      sourceRoots: [],
      vfs: new MyVfs(virtualDomPath, domSource),
      getSessionForFilePath: (filePath) => {
        if (filePath === mainPath) {
          return mainSession;
        }
        if (filePath === virtualDomPath) {
          return domSession;
        }
        return null;
      }
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(virtualDomPath).toString());
    expect(location?.range).toBeTruthy();
  });

  it("resolves inherited DOM member definitions like querySelector in a virtual workspace", async () => {
    const mainPath = "/src/main.vx";
    const virtualDomPath = "/runtime/dom.d.ts";
    const mainSource = 'const app = document.querySelector("#app")\n';
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const ambientDeclarations = (await ensureDomProgram()).body;
    const mainSession = createAnalysisSession(mainSource, { ambientDeclarations: ambientDeclarations });
    const domSession = createAnalysisSession(domSource);

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: mainSource.indexOf("querySelector") + 2,
      session: mainSession,
      sourceRoots: [],
      vfs: new MyVfs(virtualDomPath, domSource),
      getSessionForFilePath: (filePath) => {
        if (filePath === mainPath) {
          return mainSession;
        }
        if (filePath === virtualDomPath) {
          return domSession;
        }
        return null;
      }
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(virtualDomPath).toString());
    expect(location?.range).toBeTruthy();
  });

  it("resolves inherited DOM member definitions when the main file uses ambient DOM declarations but the runtime file session is standalone", async () => {
    const mainPath = "/src/main.vx";
    const virtualDomPath = "/runtime/dom.d.ts";
    const mainSource = 'const app = document.querySelector("#app")\n';
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const ambientDeclarations = (await ensureDomProgram()).body;
    const mainSession = createAnalysisSession(mainSource, { ambientDeclarations: ambientDeclarations });
    const domSession = createAnalysisSession(domSource);

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: mainSource.indexOf("querySelector") + 2,
      session: mainSession,
      sourceRoots: [],
      vfs: new MyVfs(virtualDomPath, domSource),
      getSessionForFilePath: (filePath) => {
        if (filePath === mainPath) {
          return mainSession;
        }
        if (filePath === virtualDomPath) {
          return domSession;
        }
        return null;
      }
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(virtualDomPath).toString());
    expect(location?.range).toBeTruthy();
  });

  it("resolves top-level DOM function definitions to the virtual runtime model in a virtual workspace", async () => {
    const mainPath = "/src/main.vx";
    const virtualDomPath = "/runtime/dom.d.ts";
    const mainSource = 'fetch("https://example.com/data.json")\n';
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const ambientDeclarations = (await ensureDomProgram()).body;
    const mainSession = createAnalysisSession(mainSource, { ambientDeclarations: ambientDeclarations });
    const domSession = createAnalysisSession(domSource);

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: mainSource.indexOf("fetch") + 2,
      session: mainSession,
      sourceRoots: [],
      vfs: new MyVfs(virtualDomPath, domSource),
      getSessionForFilePath: (filePath) => {
        if (filePath === mainPath) {
          return mainSession;
        }
        if (filePath === virtualDomPath) {
          return domSession;
        }
        return null;
      }
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(virtualDomPath).toString());
    expect(location?.range).toBeTruthy();
    const fetchLine = domSource.split("\n").findIndex((line) => line.includes("declare function fetch("));
    expect(location?.range.start.line).toBe(fetchLine);
  });

  it("resolves ambient global console symbol and members to their declaring .d.ts locations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-console-"));
    const nodeTypesDir = join(root, "node_modules", "@types", "node");
    const mainPath = join(root, "main.vx");
    const dtsPath = join(nodeTypesDir, "index.d.ts");
    const source = 'console.log("hello")\n';
    const dtsSource = dedent`
      interface Console {
        log(...data: any[]): void;
      }

      declare var console: Console;
    `;

    await mkdir(nodeTypesDir, { recursive: true });
    await writeFile(
      join(nodeTypesDir, "package.json"),
      JSON.stringify({ name: "@types/node", types: "index.d.ts" }),
      "utf8"
    );
    await writeFile(dtsPath, dtsSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const ambient = await loadAmbientTypesForProject(mainPath, ["node"]);
    const session = createAnalysisSession(source, { ambientDeclarations: ambient.globalDeclarations, ambientModuleDeclarations: ambient.moduleDeclarations, ambientModuleLocations: ambient.moduleDeclarationLocations, ambientDeclarationLocations: ambient.globalDeclarationLocations });

    const consoleLocation = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: source.indexOf("console") + 2,
      session,
      sourceRoots: [root]
    });
    const logLocation = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: source.indexOf("log") + 2,
      session,
      sourceRoots: [root]
    });

    expect(consoleLocation?.uri).toBe(pathToUri(dtsPath));
    expect(consoleLocation?.range.start.line).toBe(4);
    expect(logLocation?.uri).toBe(pathToUri(dtsPath));
    expect(logLocation?.range.start.line).toBe(1);
  });

  it("navigates default-imported ambient module members to their declaration", async () => {
    const source = dedent`
      import util from "node:util"
      util.format("value")
    `;
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:util", parseAmbientModule(`declare module "node:util" {
        export function format(value: string): string;
        export function inspect(value: unknown): string;
      }`, "node:util")]
    ]);
    const ambientModuleLocations = new Map([
      ["node:util", { filePath: "/virtual/@types/node/util.d.ts", line: 0, character: 0 }]
    ]);
    const baseSession = createAnalysisSession(source, { ambientModuleDeclarations: ambientModuleDeclarations, ambientModuleLocations: ambientModuleLocations });
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: "file:///virtual/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });
    const session = createAnalysisSession(source, { externalDeclarations: imported.externalDeclarations, ambientModuleDeclarations, ambientModuleLocations, importedSymbols: imported.importedSymbols });

    const location = await resolveDefinitionAcrossFiles({
      uri: "file:///virtual/main.vx",
      line: 1,
      character: source.split("\n")[1]!.indexOf("format") + 2,
      session,
      sourceRoots: []
    });

    expect(location?.uri).toBe("file:///virtual/%40types/node/util.d.ts");
    expect(location?.range.start.line).toBe(1);
  });

  it("navigates namespace-imported ambient module members to their declaration", async () => {
    const source = dedent`
      import * as util from "node:util"
      util.format("value")
    `;
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:util", parseAmbientModule(`declare module "node:util" {
        export function format(value: string): string;
        export function inspect(value: unknown): string;
      }`, "node:util")]
    ]);
    const ambientModuleLocations = new Map([
      ["node:util", { filePath: "/virtual/@types/node/util.d.ts", line: 0, character: 0 }]
    ]);
    const baseSession = createAnalysisSession(source, { ambientModuleDeclarations: ambientModuleDeclarations, ambientModuleLocations: ambientModuleLocations });
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: "file:///virtual/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });
    const session = createAnalysisSession(source, { externalDeclarations: imported.externalDeclarations, ambientModuleDeclarations, ambientModuleLocations, importedSymbols: imported.importedSymbols });

    const location = await resolveDefinitionAcrossFiles({
      uri: "file:///virtual/main.vx",
      line: 1,
      character: source.split("\n")[1]!.indexOf("format") + 2,
      session,
      sourceRoots: []
    });

    expect(location?.uri).toBe("file:///virtual/%40types/node/util.d.ts");
    expect(location?.range.start.line).toBe(1);
  });

  it("navigates namespace-imported node_modules exports to their declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-namespace-nav-"));
    const pkgDir = join(root, "node_modules", "three-like");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import * as THREE from "three-like"

      val camera = new THREE.PerspectiveCamera()
      camera.lookAt(new THREE.Vector3())
    `;
    const pkgSource = dedent`
      export class Vector3 {
      }

      export class PerspectiveCamera {
        lookAt(target: Vector3): void;
      }
    `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "three-like",
        types: "index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), pkgSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });
    const pkgLines = pkgSource.split("\n");
    const sourceLines = source.split("\n");
    const perspectiveLine = sourceLines.findIndex((line) => line.includes("PerspectiveCamera"));
    const vectorLine = sourceLines.findIndex((line) => line.includes("Vector3"));
    const perspectiveDefinitionLine = pkgLines.findIndex((line) => line.includes("export class PerspectiveCamera"));
    const vectorDefinitionLine = pkgLines.findIndex((line) => line.includes("export class Vector3"));

    const perspectiveLocation = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: perspectiveLine,
      character: sourceLines[perspectiveLine]!.indexOf("PerspectiveCamera") + 2,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const vectorLocation = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: vectorLine,
      character: sourceLines[vectorLine]!.indexOf("Vector3") + 2,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect(perspectiveLocation?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(perspectiveLocation?.range.start.line).toBe(perspectiveDefinitionLine);
    expect(vectorLocation?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(vectorLocation?.range.start.line).toBe(vectorDefinitionLine);
  });

  it("prefers the receiver's ambient declaration file when duplicate global interface names exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-console-pref-"));
    const nodeTypesDir = join(root, "node_modules", "@types", "node");
    const mainPath = join(root, "main.vx");
    const consoleDtsPath = join(nodeTypesDir, "console.d.ts");
    const globalsDtsPath = join(nodeTypesDir, "globals.d.ts");
    const indexDtsPath = join(nodeTypesDir, "index.d.ts");
    const source = 'console.log("hello")\n';
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const domDeclarations = (await ensureDomProgram()).body;
    const domDeclarationLocations = new Map(
      domDeclarations.map((statement) => [
        statement,
        {
          filePath: getDomDeclarationFilePath(),
          line: statement.firstToken?.range.start.line ?? 0,
          character: statement.firstToken?.range.start.column ?? 0
        }
      ])
    );

    await mkdir(nodeTypesDir, { recursive: true });
    await writeFile(
      join(nodeTypesDir, "package.json"),
      JSON.stringify({ name: "@types/node", types: "index.d.ts" }),
      "utf8"
    );
    await writeFile(
      consoleDtsPath,
      dedent`
        interface Console {
          log(...data: any[]): void;
        }
      `,
      "utf8"
    );
    await writeFile(
      globalsDtsPath,
      dedent`
        declare var console: Console;
      `,
      "utf8"
    );
    await writeFile(
      indexDtsPath,
      dedent`
        /// <reference path="./console.d.ts" />
        /// <reference path="./globals.d.ts" />
      `,
      "utf8"
    );
    await writeFile(mainPath, source, "utf8");

    const ambient = await loadAmbientTypesForProject(mainPath, ["node"]);
    const session = createAnalysisSession(source, { ambientDeclarations: [...domDeclarations, ...ambient.globalDeclarations], ambientModuleDeclarations: ambient.moduleDeclarations, ambientModuleLocations: ambient.moduleDeclarationLocations, ambientDeclarationLocations: new Map([
        ...domDeclarationLocations,
        ...ambient.globalDeclarationLocations
      ]) });

    const consoleLocation = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: source.indexOf("console") + 2,
      session,
      sourceRoots: [root]
    });
    const logLocation = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: source.indexOf("log") + 2,
      session,
      sourceRoots: [root]
    });

    expect(consoleLocation?.uri).toBe(pathToUri(globalsDtsPath));
    expect(logLocation?.uri).toBe(pathToUri(consoleDtsPath));
    expect(logLocation?.range.start.line).toBe(1);
    expect(logLocation?.uri).not.toBe(pathToUri(getDomDeclarationFilePath()));
    expect(domSource.length).toBeGreaterThan(0);
  });

  it("resolves top-level DOM constructor-like globals to the exact virtual runtime lines", async () => {
    const mainPath = "/src/main.vx";
    const virtualDomPath = "/runtime/dom.d.ts";
    const mainSource = "fetch(URL('hello'))\n";
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const ambientDeclarations = (await ensureDomProgram()).body;
    const mainSession = createAnalysisSession(mainSource, { ambientDeclarations: ambientDeclarations });
    const domSession = createAnalysisSession(domSource);

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: mainSource.indexOf("URL") + 2,
      session: mainSession,
      sourceRoots: [],
      vfs: new MyVfs(virtualDomPath, domSource),
      getSessionForFilePath: (filePath) => {
        if (filePath === mainPath) {
          return mainSession;
        }
        if (filePath === virtualDomPath) {
          return domSession;
        }
        return null;
      }
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(virtualDomPath).toString());
    const urlLine = domSource.split("\n").findIndex((line) => line.includes("interface URL {"));
    expect(location?.range.start.line).toBe(urlLine);
  });

  it("resolves implicit receiver method calls (bare method without this.) to the correct DOM file location", async () => {
    const mainPath = "/src/main.vx";
    const virtualDomPath = "/runtime/dom.d.ts";
    const mainSource = [
      "fun CanvasRenderingContext2D.myDraw(): void {",
      "  beginPath()",
      "}"
    ].join("\n");
    const domProgram = await ensureDomProgram();
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const ambientDeclarations = domProgram.body;
    const mainSession = createAnalysisSession(mainSource, { ambientDeclarations: ambientDeclarations });
    const domSession = createAnalysisSession(domSource);

    const beginPathLine = 1;
    const beginPathChar = mainSource.split("\n")[1]!.indexOf("beginPath") + 2;
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: beginPathLine,
      character: beginPathChar,
      session: mainSession,
      sourceRoots: [],
      vfs: new MyVfs(virtualDomPath, domSource),
      getSessionForFilePath: (filePath) => {
        if (filePath === mainPath) return mainSession;
        if (filePath === virtualDomPath) return domSession;
        return null;
      }
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(virtualDomPath).toString());
    expect(location?.range).toBeTruthy();
    const domLine = domSource.split("\n").findIndex((line) => line.includes("beginPath()"));
    expect(location?.range.start.line).toBe(domLine);
  });

  it("resolves bare inherited class methods to their declaration in the base class file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-inherited-implicit-member-navigation-"));
    const baseFile = join(root, "GameObject.vx");
    const derivedFile = join(root, "Player.vx");
    const declared = sourceWithCursor(dedent`
      export class GameObject {
        addCom^^^ponent<T>(component: T): T {
          return component
        }
      }
    `);
    const usage = sourceWithCursor(dedent`
      import { GameObject } from "./GameObject.vx"

      export class Player extends GameObject {
        constructor() {
          addCom^^^ponent(1)
        }
      }
    `);
    await writeFile(baseFile, declared.source, "utf8");
    await writeFile(derivedFile, usage.source, "utf8");

    const baseSession = createAnalysisSession(declared.source);
    const initialDerivedSession = createAnalysisSession(usage.source);
    const collected = await collectAllImportedDeclarations(initialDerivedSession.ast!, {
      uri: pathToFileURL(derivedFile).toString(),
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => filePath === baseFile ? baseSession : null
    });
    const derivedSession = createAnalysisSession(usage.source, {
      externalDeclarations: collected.externalDeclarations,
      externalDeclarationLocations: collected.externalDeclarationLocations,
      importedSymbols: collected.importedSymbols,
      invalidImportedBindings: collected.invalidImportedBindings
    });

    const location = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(derivedFile).toString(),
      line: usage.line,
      character: usage.character,
      session: derivedSession,
      sourceRoots: [root],
      getSessionForFilePath: (filePath: string) => {
        if (filePath === baseFile) return baseSession;
        if (filePath === derivedFile) return derivedSession;
        return null;
      }
    });

    expect(location).toEqual({
      uri: pathToFileURL(baseFile).toString(),
      range: {
        start: { line: declared.line, character: declared.character - 6 },
        end: { line: declared.line, character: declared.character + 6 }
      }
    });
  });

  it("resolves implicit members inside receiver-block shorthand", async () => {
    const mainPath = "/src/main.vx";
    const virtualDomPath = "/runtime/dom.d.ts";
    const cursor = sourceWithCursor(dedent`
      fun draw(context: CanvasRenderingContext2D): CanvasRenderingContext2D {
        return context. {
          begin^^^Path()
        }
      }
    `);
    const domProgram = await ensureDomProgram();
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const ambientDeclarations = domProgram.body;
    const mainSession = createAnalysisSession(cursor.source, { ambientDeclarations: ambientDeclarations });
    const domSession = createAnalysisSession(domSource);

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: cursor.line,
      character: cursor.character,
      session: mainSession,
      sourceRoots: [],
      vfs: new MyVfs(virtualDomPath, domSource),
      getSessionForFilePath: (filePath) => {
        if (filePath === mainPath) return mainSession;
        if (filePath === virtualDomPath) return domSession;
        return null;
      }
    });

    expect(mainSession.parserErrors).toEqual([]);
    expect(mainSession.semanticIssues).toEqual([]);
    expect(location?.uri).toBe(pathToFileURL(virtualDomPath).toString());
    const domLine = domSource.split("\n").findIndex((line) => line.includes("beginPath()"));
    expect(location?.range.start.line).toBe(domLine);
  });

  describe("resolveDefinitionWithLocalFallback", () => {
    it("navigates ambient node:path imports to the interface member declaration", async () => {
      const source = dedent`
        import { join } from "node:path"
        join("a", "b")
      `;
      const ambientModuleDeclarations = new Map<string, Statement[]>([
        ["node:path", parseAmbientModule(`declare module "node:path" { export = path; }`, "node:path")],
        ["path", parseAmbientModule(`declare module "path" {
          namespace path {
            interface PlatformPath {
              join(...paths: string[]): string;
            }
          }
          const path: path.PlatformPath;
          export = path;
        }`, "path")]
      ]);
      const ambientModuleLocations = new Map([
        ["node:path", { filePath: "/virtual/@types/node/path.d.ts", line: 0, character: 0 }],
        ["path", { filePath: "/virtual/@types/node/path.d.ts", line: 0, character: 0 }]
      ]);

      const baseSession = createAnalysisSession(source, { ambientModuleDeclarations: ambientModuleDeclarations, ambientModuleLocations: ambientModuleLocations });
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: "file:///virtual/main.vx",
        sourceRoots: [],
        ambientModuleDeclarations
      });
      const session = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, ambientModuleDeclarations, ambientModuleLocations, importedSymbols: collected.importedSymbols });

      const location = await resolveDefinitionWithLocalFallback({
        uri: "file:///virtual/main.vx",
        line: 1,
        character: 2,
        session,
        sourceRoots: []
      });

      expect(location).not.toBeNull();
      expect(location?.uri?.endsWith("/node/path.d.ts")).toBe(true);
      expect(location?.range.start.line).toBeGreaterThanOrEqual(0);
      expect(location?.range.start.character).toBeGreaterThanOrEqual(0);
    });

    it("navigates ambient node: module imports to the declared function definition", async () => {
      const source = dedent`
        import { readlink } from "node:fs/promises"
        readlink("demo")
      `;
      const ambientModuleDeclarations = new Map<string, Statement[]>([
        ["node:fs/promises", parseAmbientModule(`declare module "node:fs/promises" { export * from "fs/promises"; }`, "node:fs/promises")],
        ["fs/promises", parseAmbientModule(`declare module "fs/promises" { export function readlink(path: string): Promise<string>; }`, "fs/promises")]
      ]);
      const ambientModuleLocations = new Map([
        ["node:fs/promises", { filePath: "/virtual/@types/node/fs/promises.d.ts", line: 0, character: 0 }],
        ["fs/promises", { filePath: "/virtual/@types/node/fs/promises.d.ts", line: 0, character: 0 }]
      ]);

      const baseSession = createAnalysisSession(source, { ambientModuleDeclarations: ambientModuleDeclarations, ambientModuleLocations: ambientModuleLocations });
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: "file:///virtual/main.vx",
        sourceRoots: [],
        ambientModuleDeclarations
      });
      const session = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, ambientModuleDeclarations, ambientModuleLocations, importedSymbols: collected.importedSymbols });

      const location = await resolveDefinitionWithLocalFallback({
        uri: "file:///virtual/main.vx",
        line: 1,
        character: 2,
        session,
        sourceRoots: []
      });

      expect(location).not.toBeNull();
      expect(location?.uri?.endsWith("/node/fs/promises.d.ts")).toBe(true);
      expect(location?.range.start.line).toBe(0);
      expect(location?.range.start.character).toBeGreaterThanOrEqual(0);
    });

    it("hovers ambient readFile overloads without recursing forever on node typings", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-ambient-hover-"));
      const nodeTypesDir = join(root, "node_modules", "@types", "node");
      const mainPath = join(root, "main.vx");
      const source = dedent`
        import { readFile } from "fs/promises"
        await readFile("hello", { encoding: "utf-8" })
      `;

      await mkdir(nodeTypesDir, { recursive: true });
      await writeFile(
        join(nodeTypesDir, "package.json"),
        JSON.stringify({ name: "@types/node", types: "index.d.ts" }),
        "utf8"
      );
      await writeFile(
        join(nodeTypesDir, "index.d.ts"),
        dedent`
        declare module "node:events" {
          export interface AbortSignal {
            parent?: AbortSignal;
          }
          export interface Abortable {
            signal?: AbortSignal;
          }
        }

        declare module "node:fs" {
          export class Buffer {}
          export class URL {}
          export type PathLike = string | Buffer | URL;
          export type OpenMode = string;
        }

        declare module "fs/promises" {
          import { Abortable } from "node:events";
          import { OpenMode, PathLike } from "node:fs";

          export interface FileHandle {}
          export function readFile(
            path: PathLike | FileHandle,
            options: ({ encoding?: null | undefined, flag?: OpenMode | undefined } & Abortable) | null,
          ): Promise<Buffer>;
          export function readFile(
            path: PathLike | FileHandle,
            options: ({ encoding: string, flag?: OpenMode | undefined } & Abortable) | string,
          ): Promise<string>;
        }

        declare module "node:fs/promises" {
          export * from "fs/promises";
        }
        `,
        "utf8"
      );
      await writeFile(mainPath, source, "utf8");

      const ambient = await loadAmbientTypesForProject(mainPath, ["node"]);
      const baseSession = createAnalysisSession(source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        ambientModuleDeclarations: ambient.moduleDeclarations
      });
      const session = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, ambientDeclarations: ambient.globalDeclarations, ambientModuleDeclarations: ambient.moduleDeclarations, ambientModuleLocations: ambient.moduleDeclarationLocations, importedSymbols: collected.importedSymbols });

      const hover = session.analysis?.getHoverAt(1, source.split("\n")[1]!.indexOf("readFile") + 1);

      expect(hover).not.toBeNull();
      expect(hover?.contents).toContain("readFile");
      expect(hover?.contents).toContain("PathLike | FileHandle");
      expect(hover?.contents).not.toContain("string | Buffer | URL | object");
    });

    it("includes documentation when hovering directly imported ambient module functions", async () => {
      const source = dedent`
        import { readFile } from "node:fs/promises"
        await readFile("hello")
      `;
      const ambientModuleDeclarations = new Map<string, Statement[]>([
        ["node:fs/promises", parseAmbientModule(
          `declare module "node:fs/promises" {
            /**
             * Reads the entire contents of a file.
             */
            export function readFile(path: string): Promise<string>;
          }`,
          "node:fs/promises"
        )]
      ]);

      const baseSession = createAnalysisSession(source, { ambientModuleDeclarations: ambientModuleDeclarations });
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: "file:///virtual/main.vx",
        sourceRoots: [],
        ambientModuleDeclarations
      });
      const session = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, ambientModuleDeclarations, importedSymbols: collected.importedSymbols });

      const hover = await resolveHoverWithLocalFallback({
        uri: "file:///virtual/main.vx",
        line: 1,
        character: source.split("\n")[1]!.indexOf("readFile") + 1,
        session,
        sourceRoots: []
      });

      expect(hover?.contents).toEqual({
        kind: "markdown",
        value: "```typescript\nfunction readFile: (path: string) => Promise<string>\n```\n\nReads the entire contents of a file."
      });
    });

    it("navigates ambient imported calls to the matched overload declaration", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-ambient-overload-definition-"));
      const nodeTypesDir = join(root, "node_modules", "@types", "node");
      const mainPath = join(root, "main.vx");
      const { source, line, character } = sourceWithCursor(dedent`
        import { readFile } from "fs/promises"
        const file = "hello.txt"
        await readFi^^^le(file, "utf-8")
      `);
      const nodeTypesSource = dedent`
        declare module "node:events" {
          export interface AbortSignal {
            parent?: AbortSignal;
          }
          export interface Abortable {
            signal?: AbortSignal;
          }
        }

        declare module "node:fs" {
          export class Buffer {}
          export class URL {}
          export type PathLike = string | Buffer | URL;
          export type OpenMode = string | number;
        }

        declare module "fs/promises" {
          import { Abortable } from "node:events";
          import { OpenMode, PathLike } from "node:fs";

          export interface FileHandle {}
          export function readFile(
            path: PathLike | FileHandle,
            options: ({ encoding?: null | undefined, flag?: OpenMode | undefined } & Abortable) | null,
          ): Promise<Buffer>;
          export function readFile(
            path: PathLike | FileHandle,
            options: ({ encoding: string, flag?: OpenMode | undefined } & Abortable) | string,
          ): Promise<string>;
        }

        declare module "node:fs/promises" {
          export * from "fs/promises";
        }
      `;

      await mkdir(nodeTypesDir, { recursive: true });
      await writeFile(
        join(nodeTypesDir, "package.json"),
        JSON.stringify({ name: "@types/node", types: "index.d.ts" }),
        "utf8"
      );
      await writeFile(join(nodeTypesDir, "index.d.ts"), nodeTypesSource, "utf8");
      await writeFile(mainPath, source, "utf8");

      const ambient = await loadAmbientTypesForProject(mainPath, ["node"]);
      const baseSession = createAnalysisSession(source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        ambientModuleDeclarations: ambient.moduleDeclarations
      });
      const session = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, ambientDeclarations: ambient.globalDeclarations, ambientModuleDeclarations: ambient.moduleDeclarations, ambientModuleLocations: ambient.moduleDeclarationLocations, importedSymbols: collected.importedSymbols });

      const location = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line,
        character,
        session,
        sourceRoots: [root]
      });

      const overloadLines = nodeTypesSource
        .split("\n")
        .flatMap((text, index) => text.includes("export function readFile(") ? [index] : []);

      expect(overloadLines.length).toBe(2);
      expect(location).not.toBeNull();
      expect(location?.uri?.endsWith("/node/index.d.ts")).toBe(true);
      expect(location?.range.start.line).toBe(overloadLines[1]);
    });

    it("navigates imported symbol to source declaration, not import line", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-def-fallback-"));
      const fileA = join(root, "a.vx");
      const fileB = join(root, "b.vx");
      const sourceA = dedent`
        export fun greet(): string { return "hello" }
      `;
      const sourceB = dedent`
        import { greet } from "./a"
        fun demo() { greet() }
      `;
      await writeFile(fileA, sourceA, "utf8");
      await writeFile(fileB, sourceB, "utf8");

      const sessionA = createAnalysisSession(sourceA);
      const sessionB = createAnalysisSession(sourceB);
      const uriB = pathToFileURL(fileB).toString();

      // cursor on "greet" in the import specifier line (line 0, col 9)
      const importLocation = await resolveDefinitionWithLocalFallback({
        uri: uriB,
        line: 0,
        character: 9,
        session: sessionB,
        sourceRoots: [root],
        getSessionForFilePath: (p) => {
          if (p === fileA) return sessionA;
          if (p === fileB) return sessionB;
          return null;
        },
      });

      expect(importLocation).not.toBeNull();
      expect(importLocation?.uri).toBe(pathToFileURL(fileA).toString());
      expect(importLocation?.range.start.line).toBe(0);

      // cursor on the call "greet()" usage (line 1, col 13)
      const callLocation = await resolveDefinitionWithLocalFallback({
        uri: uriB,
        line: 1,
        character: 13,
        session: sessionB,
        sourceRoots: [root],
        getSessionForFilePath: (p) => {
          if (p === fileA) return sessionA;
          if (p === fileB) return sessionB;
          return null;
        },
      });

      expect(callLocation).not.toBeNull();
      expect(callLocation?.uri).toBe(pathToFileURL(fileA).toString());
      expect(callLocation?.range.start.line).toBe(0);
    });

  it("navigates node_modules named imports at call sites to the typings declaration", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-node-module-definition-"));
      const pkgDir = join(root, "node_modules", "preact");
      const hooksDir = join(pkgDir, "hooks");
      const mainPath = join(root, "main.vx");
      const { source, line, character } = sourceWithCursor(dedent`
        import { useState } from "preact/hooks"
        const [count, setCount] = useSt^^^ate(0)
        setCount(count + 1)
      `);

      await mkdir(join(pkgDir, "src"), { recursive: true });
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
      await writeFile(join(pkgDir, "src", "index.d.ts"), "export function render(vnode: unknown, parent: unknown): void;\n", "utf8");
      await writeFile(
        join(hooksDir, "src", "index.d.ts"),
        dedent`
          export type Dispatch<A> = (value: A) => void;
          export type StateUpdater<S> = S | ((prevState: S) => S);
          export function useState<S>(initialState: S | (() => S)): [S, Dispatch<StateUpdater<S>>];
        `,
        "utf8"
      );
      await writeFile(mainPath, source, "utf8");

      const baseSession = createAnalysisSession(source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const session = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

      const location = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line,
        character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect(location).not.toBeNull();
    expect(location?.uri.endsWith("/node_modules/preact/hooks/src/index.d.ts")).toBe(true);
    expect(location?.range.start.line).toBe(2);
  });

    it("navigates node_modules member access through export-star barrels to the original declaration file", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-node-module-definition-"));
      const pkgDir = join(root, "node_modules", "preact");
      const mainPath = join(root, "main.vx");
      const { source, line, character } = sourceWithCursor(dedent`
        import { Widget } from "preact"

        fun demo() {
          val widget = new Widget()
          widget.drawRoundedRe^^^ct(0, 0, 10, 20, 5)
        }
      `);

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
      await writeFile(mainPath, source, "utf8");

      const baseSession = createAnalysisSession(source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const session = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

      const location = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line,
        character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect(location).not.toBeNull();
      expect(location?.uri.endsWith("/node_modules/preact/src/dom.d.ts")).toBe(true);
      expect(location?.range.start.line).toBe(1);
    });

    it("navigates members of imported generic classes that rely on default type arguments", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-node-module-definition-"));
      const pkgDir = join(root, "node_modules", "pkg");
      const mainPath = join(root, "main.vx");
      const marked = sourceWithCursor(dedent`
        import { Application } from "pkg"

        val app = Application()
        app.renderer.resi^^^ze(100, 200)
      `);

      await mkdir(join(pkgDir, "src"), { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "pkg",
          types: "./src/index.d.ts"
        }),
        "utf8"
      );
      await writeFile(
        join(pkgDir, "src", "index.d.ts"),
        dedent`
          export interface Renderer {
            resize(width: number, height: number): void;
          }

          export declare class Application<R = Renderer> {
            renderer: R;
            constructor();
          }
        `,
        "utf8"
      );
      await writeFile(mainPath, marked.source, "utf8");

      const baseSession = createAnalysisSession(marked.source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const session = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

      const hover = await resolveHoverWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const location = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect((hover?.contents as { value?: string } | undefined)?.value).toContain("resize: (width: number, height: number) => void");
      expect(location?.uri.endsWith("/node_modules/pkg/src/index.d.ts")).toBe(true);
      expect(location?.range.start.line).toBe(1);
    });

    it("navigates and hovers imported generic interface members specialized through node_modules function calls", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-node-module-definition-"));
      const pkgDir = join(root, "node_modules", "pkg");
      const mainPath = join(root, "main.vx");
      const marked = sourceWithCursor(dedent`
        import { QueryClient, useQuery } from "pkg"

        val queryClient = QueryClient()
        val result = useQuery({
          queryKey: ["roadmap"],
          queryFn: async (context) => {
            return { title: String(context.queryKey[0]) }
          }
        }, queryClient)

        if (result.isLoa^^^ding) {
          log("loading")
        }
      `);

      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "pkg",
          types: "./index.d.ts"
        }),
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
      await writeFile(mainPath, marked.source, "utf8");

      const baseSession = createAnalysisSession(marked.source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const session = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

      const hover = await resolveHoverWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const location = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect((hover?.contents as { value?: string } | undefined)?.value).toContain("isLoading: boolean");
      expect(location?.uri.endsWith("/node_modules/pkg/index.d.ts")).toBe(true);
      expect(location?.range.start.line).toBe(19);
    });

    it("navigates imported generic result data members after node_modules specialization", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-node-module-definition-"));
      const pkgDir = join(root, "node_modules", "pkg");
      const mainPath = join(root, "main.vx");
      const marked = sourceWithCursor(dedent`
        import { QueryClient, useQuery } from "pkg"

        val queryClient = QueryClient()
        val result = useQuery({
          queryKey: ["roadmap"],
          queryFn: async (context) => {
            return { title: String(context.queryKey[0]) }
          }
        }, queryClient)

        if (result.da^^^ta) {
          log(result.data.title)
        }
      `);

      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "pkg",
          types: "./index.d.ts"
        }),
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
      await writeFile(mainPath, marked.source, "utf8");

      const baseSession = createAnalysisSession(marked.source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const session = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

      const hover = await resolveHoverWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const location = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect((hover?.contents as { value?: string } | undefined)?.value)
        .toContain("data: {\n  title: string;\n} | undefined");
      expect(location?.uri.endsWith("/node_modules/pkg/index.d.ts")).toBe(true);
      expect(location?.range.start.line).toBe(18);
    });

    it("navigates type names and generic arguments inside extends clauses", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-node-module-definition-"));
      const pkgDir = join(root, "node_modules", "preact");
      const mainPath = join(root, "main.vx");
      const baseMarked = sourceWithCursor(dedent`
        import { InputHTMLAttributes } from "preact"

        interface HTMLInputElement {
        }

        interface InputProperties extends InputHTMLAttr^^^ibutes<HTMLInputElement> {
          mySpecialProp: any
        }
      `);
      const genericMarked = sourceWithCursor(dedent`
        import { InputHTMLAttributes } from "preact"

        interface HTMLInputElement {
        }

        interface InputProperties extends InputHTMLAttributes<HTMLInputEleme^^^nt> {
          mySpecialProp: any
        }
      `);

      await mkdir(join(pkgDir, "src"), { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "preact",
          types: "src/index.d.ts"
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
      await writeFile(mainPath, baseMarked.source, "utf8");

      const baseSession = createAnalysisSession(baseMarked.source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const session = createAnalysisSession(baseMarked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

      const baseLocation = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: baseMarked.line,
        character: baseMarked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect(baseLocation).not.toBeNull();
      expect(baseLocation?.uri.endsWith("/node_modules/preact/src/dom.d.ts")).toBe(true);
      expect(baseLocation?.range.start.line).toBe(4);

      const genericLocation = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: genericMarked.line,
        character: genericMarked.character,
        session: createAnalysisSession(genericMarked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols }),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect(genericLocation).toEqual({
        uri: pathToFileURL(mainPath).toString(),
        range: {
          start: { line: 2, character: 10 },
          end: { line: 2, character: 26 }
        }
      });
    });

  it("navigates and hovers imported class names inside extends clauses for merged preact-style declarations", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-node-module-definition-"));
      const pkgDir = join(root, "node_modules", "preact");
      const mainPath = join(root, "main.vx");
      const marked = sourceWithCursor(dedent`
        import { Component } from "preact"

        class Clock extends Compo^^^nent<{ label: string }, { time: number }> {
          state: { time: number }

          constructor() {
            super()
            this.state = { time: Date.now() }
          }
        }
      `);

      await mkdir(join(pkgDir, "src"), { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "preact",
          types: "src/index.d.ts"
        }),
        "utf8"
      );
      await writeFile(
        join(pkgDir, "src", "index.d.ts"),
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
        `,
        "utf8"
      );
      await writeFile(mainPath, marked.source, "utf8");

      const baseSession = createAnalysisSession(marked.source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const session = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

      const location = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const hover = await resolveHoverWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect(location).not.toBeNull();
      expect(location?.uri.endsWith("/node_modules/preact/src/index.d.ts")).toBe(true);
      expect((hover?.contents as { value?: string } | undefined)?.value).toContain("Component");
    });

    it("navigates ambient global namespace receivers and their members loaded from compilerOptions.types", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-react-ambient-navigation-"));
      const reactTypesDir = join(root, "node_modules", "@types", "react");
      const mainPath = join(root, "main.vx");
      const reactMarked = sourceWithCursor(dedent`
        fun demo() {
          var count by Rea^^^ct.useState<number>(0)
        }
      `);
      const memberMarked = sourceWithCursor(dedent`
        fun demo() {
          var count by React.useSt^^^ate<number>(0)
        }
      `);

      await mkdir(reactTypesDir, { recursive: true });
      await writeFile(
        join(reactTypesDir, "package.json"),
        JSON.stringify({
          name: "@types/react",
          types: "index.d.ts"
        }),
        "utf8"
      );
      await writeFile(
        join(reactTypesDir, "index.d.ts"),
        dedent`
          export as namespace React

          declare namespace React {
            function useState<S>(initialState: S): [S, (value: S) => void]
          }

          declare module "react" {
            export = React
          }
        `,
        "utf8"
      );
      await writeFile(mainPath, reactMarked.source, "utf8");

      const ambient = await loadAmbientTypesForProject(mainPath, ["react"]);
      const sessionFor = (source: string) => createAnalysisSession(source, { ambientDeclarations: ambient.globalDeclarations, ambientModuleDeclarations: ambient.moduleDeclarations, ambientModuleLocations: ambient.moduleDeclarationLocations, ambientDeclarationLocations: ambient.globalDeclarationLocations });

      const reactLocation = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: reactMarked.line,
        character: reactMarked.character,
        session: sessionFor(reactMarked.source),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect(reactLocation).not.toBeNull();
      expect(reactLocation?.uri.includes("/node_modules/%40types/react/index.d.ts")).toBe(true);
      expect(reactLocation?.range.start.line).toBe(2);

      const memberLocation = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: memberMarked.line,
        character: memberMarked.character,
        session: sessionFor(memberMarked.source),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect(memberLocation).not.toBeNull();
      expect(memberLocation?.uri.includes("/node_modules/%40types/react/index.d.ts")).toBe(true);
      expect(memberLocation?.range.start.line).toBe(3);
    });

    it("navigates contextual node_modules object literal properties to the reexported source declaration", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-node-module-definition-"));
      const pkgDir = join(root, "node_modules", "pixi-like");
      const mainPath = join(root, "main.vx");
      const marked = sourceWithCursor(dedent`
        import { TextStyle } from "pixi-like"

        val style = TextStyle({
          fo^^^ntSize: 24,
        })
      `);

      await mkdir(join(pkgDir, "scene", "text"), { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "pixi-like",
          types: "index.d.ts"
        }),
        "utf8"
      );
      await writeFile(
        join(pkgDir, "index.d.ts"),
        dedent`
          export * from "./scene/text/TextStyle";
        `,
        "utf8"
      );
      await writeFile(
        join(pkgDir, "scene", "text", "TextStyle.d.ts"),
        dedent`
          export interface TextStyleOptions {
            fill?: number;
            fontSize?: number | string;
          }

          export declare class TextStyle {
            constructor(options?: Partial<TextStyleOptions>);
          }
        `,
        "utf8"
      );
      await writeFile(mainPath, marked.source, "utf8");

      const baseSession = createAnalysisSession(marked.source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const session = createAnalysisSession(marked.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });

      const location = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const hover = await resolveHoverWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect(location).not.toBeNull();
      expect(location?.uri.endsWith("/node_modules/pixi-like/scene/text/TextStyle.d.ts")).toBe(true);
      expect(location?.range.start.line).toBe(2);
      expect((hover?.contents as { value?: string } | undefined)?.value).toBe(
        "```typescript\nfontSize: number | string\n```"
      );
    });

    it("falls back to local definition when no cross-file resolution matches", async () => {
      const source = dedent`
        fun localFn(): int { return 42 }
        fun demo() { localFn() }
      `;
      const uri = "file:///virtual/test.vx";
      const session = createAnalysisSession(source);

      // cursor on "localFn" call (line 1, col 13)
      const location = await resolveDefinitionWithLocalFallback({
        uri,
        line: 1,
        character: 13,
        session,
        sourceRoots: [],
      });

      expect(location).not.toBeNull();
      expect(location?.uri).toBe(uri);
      expect(location?.range.start.line).toBe(0);
    });

    it("resolves the extension-property receiver type name to its local class definition", async () => {
      const marked = sourceWithCursor(dedent`
        class View(var x: number, var y: number)
        var Vie^^^w.point: Vec2 {
          get => Vec2(x, y)
        }
        class Vec2(val x: number, val y: number)
      `);
      const uri = "file:///virtual/test.vx";
      const session = createAnalysisSession(marked.source);

      const location = await resolveDefinitionWithLocalFallback({
        uri,
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [],
      });

      expect(location).not.toBeNull();
      expect(location?.uri).toBe(uri);
      expect(location?.range.start.line).toBe(0);
      expect(location?.range.start.character).toBe(6);
    });
  });

  it("keeps the cross-file module layering acyclic", async () => {
    // crossFileNavigation.ts orchestrates the operations on top of the shared
    // helper modules; the helpers must never import back from it (or from each
    // other in the wrong direction), so they stay reusable in isolation.
    const contextSource = await readFile("compiler/lsp/crossFileContext.ts", "utf8");
    const typeResolutionSource = await readFile("compiler/lsp/crossFileTypeResolution.ts", "utf8");

    expect(contextSource.includes("./crossFileNavigation")).toBe(false);
    expect(contextSource.includes("./crossFileTypeResolution")).toBe(false);
    expect(typeResolutionSource.includes("./crossFileNavigation")).toBe(false);
    expect(typeResolutionSource.includes("./crossFileContext")).toBe(true);
  });

  describe("findAmbientNamedExportRange", () => {
    it("finds a directly declared symbol inside a declare module block", () => {
      const declarations = parseAmbientModule(
        `declare module "my-module" {
          export function readFile(path: string): string;
          export function writeFile(path: string, data: string): void;
        }`,
        "my-module"
      );

      const range = findAmbientNamedExportRange(declarations, "readFile");
      expect(range).not.toBeNull();
      expect(range?.start.line).toBeGreaterThanOrEqual(0);
      // "readFile" appears after "function " on line 1 (0-indexed)
      const src = `declare module "my-module" {\n  export function readFile(path: string): string;\n  export function writeFile(path: string, data: string): void;\n}`;
      const lineText = src.split("\n")[range?.start.line ?? -1] ?? "";
      expect(lineText).toContain("readFile");
    });

    it("finds a symbol via the export = namespace body pattern", () => {
      // Mirrors the node:path / path pattern used in real @types/node
      const declarations = parseAmbientModule(
        `declare module "path" {
          namespace path {
            interface PlatformPath {
              join(...paths: string[]): string;
              resolve(...paths: string[]): string;
            }
          }
          const path: path.PlatformPath;
          export = path;
        }`,
        "path"
      );

      const range = findAmbientNamedExportRange(declarations, "join");
      expect(range).not.toBeNull();
      // The range must point to the "join" member inside the PlatformPath interface
      const src = `declare module "path" {\n  namespace path {\n    interface PlatformPath {\n      join(...paths: string[]): string;\n      resolve(...paths: string[]): string;\n    }\n  }\n  const path: path.PlatformPath;\n  export = path;\n}`;
      const lineText = src.split("\n")[range?.start.line ?? -1] ?? "";
      expect(lineText).toContain("join");
    });

    it("returns null for a name not present in the declarations", () => {
      const declarations = parseAmbientModule(
        `declare module "my-module" {
          export function knownExport(): void;
        }`,
        "my-module"
      );

      const range = findAmbientNamedExportRange(declarations, "unknownExport");
      expect(range).toBeNull();
    });

    it("finds a symbol declared inside a global {} block within a module", () => {
      // When declarations are assembled directly (not via ambientTypesLoader which
      // flattens global blocks), a declare global {} NamespaceStatement inside the
      // module body should be searched as a fallback.
      const declarations = parseAmbientModule(
        `declare module "augmenting-module" {
          export function moduleExport(): void;
          global {
            function globalHelper(): void;
          }
        }`,
        "augmenting-module"
      );

      // The module export should resolve directly.
      const moduleRange = findAmbientNamedExportRange(declarations, "moduleExport");
      expect(moduleRange).not.toBeNull();

      // The global {} member should be found via the global block search.
      const globalRange = findAmbientNamedExportRange(declarations, "globalHelper");
      expect(globalRange).not.toBeNull();
    });
  });

  describe("rename and prepareRename for runtime/ambient symbols", () => {
    it("resolveRenameAcrossFiles returns null for a built-in ECMAScript runtime symbol", async () => {
      // parseInt is declared in the ECMAScript runtime (es2025.d.ts), so
      // renaming it would only patch usage sites while leaving the declaration
      // untouched — a half-working rename that must be blocked.
      await ensureEcmaScriptRuntimeProgram();
      const runtimeDeclarations = getEcmaScriptRuntimeProgram().body;

      const { source, line, character } = sourceWithCursor(dedent`
        val result = par^^^seInt("42", 10)
      `);

      const root = await mkdtemp(join(tmpdir(), "vexa-rename-runtime-"));
      const file = join(root, "main.vx");
      await writeFile(file, source, "utf8");

      const session = createAnalysisSession(source, { ambientDeclarations: runtimeDeclarations });
      const edit = await resolveRenameAcrossFiles(
        {
          uri: pathToFileURL(file).toString(),
          line,
          character,
          session,
          sourceRoots: [root]
        },
        "parseInteger"
      );

      expect(edit).toBeNull();
    });

    it("resolveRenameAcrossFiles succeeds for a local user-defined function", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-rename-local-"));
      const file = join(root, "main.vx");

      const { source, line, character } = sourceWithCursor(dedent`
        fun greet(name: string): string { return "Hello " + name }
        val msg = gre^^^et("World")
      `);

      await writeFile(file, source, "utf8");

      const session = createAnalysisSession(source);
      const edit = await resolveRenameAcrossFiles(
        {
          uri: pathToFileURL(file).toString(),
          line,
          character,
          session,
          sourceRoots: [root]
        },
        "sayHello"
      );

      expect(edit).not.toBeNull();
      expect(edit?.changes?.[pathToFileURL(file).toString()]).toBeDefined();
    });

    it("resolvePrepareRenameAcrossFiles returns null for a built-in ECMAScript runtime symbol", async () => {
      // parseFloat lives in the ECMAScript runtime; prepareRename must refuse it.
      await ensureEcmaScriptRuntimeProgram();
      const runtimeDeclarations = getEcmaScriptRuntimeProgram().body;

      const { source, line, character } = sourceWithCursor(dedent`
        val n = parseF^^^loat("3.14")
      `);

      const root = await mkdtemp(join(tmpdir(), "vexa-prepare-rename-runtime-"));
      const file = join(root, "main.vx");
      await writeFile(file, source, "utf8");

      const session = createAnalysisSession(source, { ambientDeclarations: runtimeDeclarations });
      const result = await resolvePrepareRenameAcrossFiles({
        uri: pathToFileURL(file).toString(),
        line,
        character,
        session,
        sourceRoots: [root]
      });

      expect(result).toBeNull();
    });

    it("resolvePrepareRenameAcrossFiles returns a valid result for a local symbol", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-prepare-rename-local-"));
      const file = join(root, "main.vx");

      const { source, line, character } = sourceWithCursor(dedent`
        fun localFu^^^nction(): int { return 1 }
      `);

      await writeFile(file, source, "utf8");

      const session = createAnalysisSession(source);
      const result = await resolvePrepareRenameAcrossFiles({
        uri: pathToFileURL(file).toString(),
        line,
        character,
        session,
        sourceRoots: [root]
      });

      expect(result).not.toBeNull();
      expect((result as { placeholder?: string })?.placeholder).toBe("localFunction");
    });
  });
});
