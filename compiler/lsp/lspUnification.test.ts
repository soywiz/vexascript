/**
 * Cross-feature LSP unification tests.
 *
 * Verifies that hover, definition, and references agree on the same canonical
 * symbol, and that new unified entrypoints (resolveHoverWithLocalFallback,
 * resolveImportSpecifierDefinition) work correctly.
 */
import { describe, expect, it, join, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { Analysis } from "compiler/analysis/Analysis";
import { createAnalysisSession } from "./analysisSession";
import {
  createHover,
  createDefinitionLocation,
  createReferences,
  createPrepareRename,
  createRenameWorkspaceEdit
} from "./navigation";
import {
  resolveDefinitionWithLocalFallback,
  resolveHoverWithLocalFallback,
  resolvePrepareRenameAcrossFiles,
  resolveRenameAcrossFiles
} from "./crossFileNavigation";
import { createSignatureHelp } from "./signatureHelp";
import { collectAllImportedDeclarations } from "./importedDeclarations";
import {
  ensureEcmaScriptRuntimeProgram,
  getEcmaScriptRuntimeProgram
} from "compiler/runtime/ecmascriptDeclarations";

const TEST_URI = "file:///test.vx";

describe("LSP unification", () => {
  describe("same target across features for a local function", () => {
    it("hover, definition, and references agree on the same symbol", () => {
      const marked = sourceWithCursor(dedent`
        fun greet(name: string): string => "Hello " + name
        fun demo() { return gre^^^et("world") }
      `);
      const { source, line, character } = marked;
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);

      const hover = createHover(analysis, line, character, ast);
      const definition = createDefinitionLocation(analysis, TEST_URI, line, character, ast);
      const references = createReferences(analysis, TEST_URI, line, character, true, ast);

      // All three should resolve to greet
      expect(hover?.contents).toEqual(expect.objectContaining({ kind: "plaintext" }));
      expect(definition?.uri).toBe(TEST_URI);
      // definition should point to line 0 where greet is declared
      expect(definition?.range.start.line).toBe(0);
      // references should include the declaration and the usage
      expect(references.length).toBeGreaterThanOrEqual(2);
    });

    it("rename and signature help agree with hover/definition/references on the same symbol", async () => {
      const marked = sourceWithCursor(dedent`
        fun greet(name: string): string => "Hello " + name
        fun demo() { return gre^^^et("world") }
      `);
      const { source, line, character } = marked;
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);

      const hover = createHover(analysis, line, character, ast);
      const definition = createDefinitionLocation(analysis, TEST_URI, line, character, ast);
      const references = createReferences(analysis, TEST_URI, line, character, true, ast);
      const prepareRename = createPrepareRename(analysis, line, character, ast) as {
        placeholder?: string;
        range?: { start: { line: number; character: number } };
      } | null;
      const renameEdit = createRenameWorkspaceEdit(analysis, TEST_URI, line, character, "salute", ast);

      // prepareRename should target the same call-site range that references reports
      expect(prepareRename?.placeholder).toBe("greet");
      expect(references.some((reference) =>
        reference.range.start.line === prepareRename?.range?.start.line &&
        reference.range.start.character === prepareRename?.range?.start.character
      )).toBe(true);

      // The rename edit should touch both the declaration (line 0) and the call site,
      // matching the locations definition/references already agreed on.
      const renameRanges = renameEdit?.changes?.[TEST_URI] ?? [];
      expect(renameRanges.length).toBe(references.length);
      expect(renameRanges.some((change) => change.range.start.line === definition?.range.start.line)).toBe(true);
      expect(renameRanges.every((change) => change.newText === "salute")).toBe(true);

      // Signature help invoked inside the call parentheses should describe the
      // same `greet(name: string)` declaration that hover/definition resolved.
      const callMarked = sourceWithCursor(dedent`
        fun greet(name: string): string => "Hello " + name
        fun demo() { return greet(^^^"world") }
      `);
      const callAst = parseFile(tokenizeReader(callMarked.source));
      const callAnalysis = new Analysis(callAst);
      const signatureHelp = await createSignatureHelp(callAst, callAnalysis, callMarked.line, callMarked.character);

      expect(signatureHelp?.signatures.length).toBe(1);
      expect(signatureHelp?.signatures[0]?.label).toBe("greet(name: string): string");
      expect(hover?.contents).toEqual({
        kind: "plaintext",
        value: "function greet: (name: string) => string"
      });
    });
  });

  describe("import specifier navigation", () => {
    it("clicking on the import specifier name jumps to the source declaration", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-lsp-unification-"));
      const fileA = join(root, "a.vx");
      const fileB = join(root, "b.vx");

      const sourceA = "export fun greet(name: string): string => \"Hello \" + name\n";
      const marked = sourceWithCursor(
        `import { gre^^^et } from "./a"\nfun demo() { greet("world") }\n`
      );

      await writeFile(fileA, sourceA, "utf8");
      await writeFile(fileB, marked.source, "utf8");

      const sessionB = createAnalysisSession(marked.source);
      const definition = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(fileB).toString(),
        line: marked.line,
        character: marked.character,
        session: sessionB,
        sourceRoots: [root]
      });

      // Should jump to the declaration in a.vx, not stop at the import site
      expect(definition?.uri).toBe(pathToFileURL(fileA).toString());
      expect(definition?.range.start.line).toBe(0);
    });

    it("hover on import specifier resolves the local fallback hover", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-lsp-unification-"));
      const fileA = join(root, "a.vx");
      const fileB = join(root, "b.vx");

      const sourceA = "export fun greet(name: string): string => \"Hello \" + name\n";
      const marked = sourceWithCursor(
        `import { gre^^^et } from "./a"\nfun demo() { greet("world") }\n`
      );

      await writeFile(fileA, sourceA, "utf8");
      await writeFile(fileB, marked.source, "utf8");

      const sessionB = createAnalysisSession(marked.source);
      const hover = await resolveHoverWithLocalFallback({
        uri: pathToFileURL(fileB).toString(),
        line: marked.line,
        character: marked.character,
        session: sessionB,
        sourceRoots: [root]
      });

      // Should return a hover (not null) - analysis hover for the imported binding
      expect(hover).not.toBeNull();
    });

    it("import path hover and definition agree on the same resolved file", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-lsp-unification-"));
      const fileA = join(root, "a.vx");
      const fileB = join(root, "b.vx");

      await writeFile(fileA, "export fun greet(name: string): string => \"Hello \" + name\n", "utf8");

      const marked = sourceWithCursor(`import { greet } from "./^^^a"\nfun demo() { greet("world") }\n`);
      await writeFile(fileB, marked.source, "utf8");

      const sessionB = createAnalysisSession(marked.source);
      const context = {
        uri: pathToFileURL(fileB).toString(),
        line: marked.line,
        character: marked.character,
        session: sessionB,
        sourceRoots: [root]
      };

      const hover = await resolveHoverWithLocalFallback(context);
      const definition = await resolveDefinitionWithLocalFallback(context);

      expect(hover?.contents).toEqual(expect.objectContaining({ kind: "plaintext" }));
      expect((hover?.contents as { value: string }).value).toContain("module:");
      expect((hover?.contents as { value: string }).value).toContain(fileA);
      expect(definition).toEqual({
        uri: pathToFileURL(fileA).toString(),
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
      });
    });
  });

  describe("imported symbol navigation at call site", () => {
    it("definition for imported symbol at call site jumps to source declaration", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-lsp-unification-"));
      const fileA = join(root, "a.vx");
      const fileB = join(root, "b.vx");

      const sourceA = "export fun greet(name: string): string => \"Hello \" + name\n";
      const cursorInB = sourceWithCursor(
        `import { greet } from "./a"\nfun demo() { return gre^^^et("world") }`
      );

      await writeFile(fileA, sourceA, "utf8");
      await writeFile(fileB, cursorInB.source, "utf8");

      const sessionB = createAnalysisSession(cursorInB.source);
      const definition = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(fileB).toString(),
        line: cursorInB.line,
        character: cursorInB.character,
        session: sessionB,
        sourceRoots: [root]
      });

      expect(definition?.uri).toBe(pathToFileURL(fileA).toString());
    });

    it("hover, definition, references, rename, and signature help all agree on an imported function at its call site", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-lsp-unification-"));
      const fileA = join(root, "a.vx");
      const fileB = join(root, "b.vx");

      const sourceA = "export fun greet(name: string): string => \"Hello \" + name\n";
      const cursorInB = sourceWithCursor(
        `import { greet } from "./a"\nfun demo() { return gre^^^et("world") }`
      );

      await writeFile(fileA, sourceA, "utf8");
      await writeFile(fileB, cursorInB.source, "utf8");

      const sessionB = createAnalysisSession(cursorInB.source);
      const context = {
        uri: pathToFileURL(fileB).toString(),
        line: cursorInB.line,
        character: cursorInB.character,
        session: sessionB,
        sourceRoots: [root]
      };

      const hover = await resolveHoverWithLocalFallback(context);
      const definition = await resolveDefinitionWithLocalFallback(context);
      const prepareRename = await resolvePrepareRenameAcrossFiles(context) as { placeholder?: string } | null;
      const renameEdit = await resolveRenameAcrossFiles(context, "salute");

      // hover and definition both resolve into the source file a.vx
      expect(hover).not.toBeNull();
      expect(definition?.uri).toBe(pathToFileURL(fileA).toString());
      expect(definition?.range.start.line).toBe(0);

      // The imported function is a project-local symbol, so it should remain
      // renameable, and the rename should touch the call site in b.vx.
      expect(prepareRename?.placeholder).toBe("greet");
      const fileBChanges = renameEdit?.changes?.[pathToFileURL(fileB).toString()] ?? [];
      expect(fileBChanges.length).toBeGreaterThanOrEqual(1);
      expect(fileBChanges.every((change) => change.newText === "salute")).toBe(true);

      // Signature help at the call site should describe the same `greet(name: string)`
      // declaration that hover/definition resolved across files.
      const sigMarked = sourceWithCursor(
        `import { greet } from "./a"\nfun demo() { return greet(^^^"world") }`
      );
      await writeFile(fileB, sigMarked.source, "utf8");
      const sigCtx = { uri: pathToFileURL(fileB).toString(), sourceRoots: [root] };
      const sigBaseSession = createAnalysisSession(sigMarked.source);
      const sigCollected = await collectAllImportedDeclarations(sigBaseSession.ast!, sigCtx);
      const sigSession = createAnalysisSession(sigMarked.source, { externalDeclarations: sigCollected.externalDeclarations, importedSymbols: sigCollected.importedSymbols });
      const sigHelp = await createSignatureHelp(sigSession.ast!, sigSession.analysis!, sigMarked.line, sigMarked.character, sigCtx);

      expect(sigHelp?.signatures.length).toBe(1);
      expect(sigHelp?.signatures[0]?.label).toBe("greet(name: string): string");
    });
  });

  describe("annotation hover and definition", () => {
    it("annotation reference resolves consistently between hover and definition", () => {
      const marked = sourceWithCursor(dedent`
        annotation MyAnnotation(value: string)
        @MyA^^^nnotation("test")
        fun demo() {}
      `);
      const { source, line, character } = marked;
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);

      const hover = createHover(analysis, line, character, ast);
      const definition = createDefinitionLocation(analysis, TEST_URI, line, character, ast);

      // hover should say "annotation MyAnnotation(...)"
      expect(hover?.contents).toEqual(expect.objectContaining({ kind: "plaintext" }));
      const hoverValue = (hover?.contents as { value: string }).value;
      expect(hoverValue).toContain("annotation MyAnnotation");
      expect(hoverValue).toContain("value: string");
      // definition should point to line 0 where MyAnnotation is declared
      expect(definition?.uri).toBe(TEST_URI);
      expect(definition?.range.start.line).toBe(0);
    });
  });

  describe("documentation parameter", () => {
    it("doc parameter reference resolves consistently between hover and definition", () => {
      const marked = sourceWithCursor(dedent`
        /// Returns the sum of [a^^^] and b.
        fun add(a: number, b: number): number => a + b
      `);
      const { source, line, character } = marked;
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);

      const hover = createHover(analysis, line, character, ast);
      const definition = createDefinitionLocation(analysis, TEST_URI, line, character, ast);

      expect(hover?.contents).toEqual({
        kind: "plaintext",
        value: "parameter a: number"
      });
      // definition should point to parameter `a` in the function signature
      expect(definition?.uri).toBe(TEST_URI);
      expect(definition?.range.start.line).toBe(1);
    });
  });

  describe("member hover and definition", () => {
    it("class member hover and definition agree on the same symbol", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-lsp-unification-"));
      const fileA = join(root, "a.vx");
      const fileB = join(root, "b.vx");

      const sourceA = dedent`
        export class Point {
          var x: number = 0
          var y: number = 0
        }
      `;
      const markedB = sourceWithCursor(dedent`
        import { Point } from "./a"
        fun demo(p: Point) { return p.^^^x }
      `);

      await writeFile(fileA, sourceA, "utf8");
      await writeFile(fileB, markedB.source, "utf8");

      const sessionB = createAnalysisSession(markedB.source);
      const context = {
        uri: pathToFileURL(fileB).toString(),
        line: markedB.line,
        character: markedB.character,
        session: sessionB,
        sourceRoots: [root]
      };

      const hover = await resolveHoverWithLocalFallback(context);
      const definition = await resolveDefinitionWithLocalFallback(context);

      // Hover should show x's type
      expect(hover?.contents).toEqual({
        kind: "plaintext",
        value: "x: number"
      });
      // Definition should point to a.vx
      expect(definition?.uri).toBe(pathToFileURL(fileA).toString());
    });
  });

  describe("resolveHoverWithLocalFallback", () => {
    it("returns import path hover when cursor is on an import string", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-lsp-unification-"));
      const fileA = join(root, "a.vx");
      const fileB = join(root, "b.vx");

      await writeFile(fileA, "export fun foo() {}\n", "utf8");

      const marked = sourceWithCursor(`import { foo } from "./^^^a"\n`);
      await writeFile(fileB, marked.source, "utf8");

      const sessionB = createAnalysisSession(marked.source);
      const hover = await resolveHoverWithLocalFallback({
        uri: pathToFileURL(fileB).toString(),
        line: marked.line,
        character: marked.character,
        session: sessionB,
        sourceRoots: [root]
      });

      expect(hover?.contents).toEqual(expect.objectContaining({ kind: "plaintext" }));
      const contents = (hover?.contents as { value: string }).value;
      expect(contents).toContain("module:");
    });
  });

  describe("local function overloads", () => {
    // Two top-level `greet` overloads sharing a name (see "Function overloads"
    // in docs/syntax.md): a zero-parameter signature and a one-parameter
    // signature. Hover/definition/references/rename treat both overloads as a
    // single declared symbol (anchored at the first overload), while signature
    // help must distinguish between them by argument count.
    const overloadSource = dedent`
      fun greet(): string { return "hi" }
      fun greet(name: string): string { return "Hello " + name }
      fun demo() { return gre^^^et("world") }
    `;

    it("hover, definition, references, and rename agree on the overloaded declaration", () => {
      const marked = sourceWithCursor(overloadSource);
      const { source, line, character } = marked;
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);

      const hover = createHover(analysis, line, character, ast);
      const definition = createDefinitionLocation(analysis, TEST_URI, line, character, ast);
      const references = createReferences(analysis, TEST_URI, line, character, true, ast);
      const prepareRename = createPrepareRename(analysis, line, character, ast) as { placeholder?: string } | null;
      const renameEdit = createRenameWorkspaceEdit(analysis, TEST_URI, line, character, "salute", ast);

      // Hover should describe both overload signatures.
      expect(hover?.contents).toEqual({
        kind: "plaintext",
        value: "function greet: () => string | (name: string) => string"
      });
      // Definition/rename/references all anchor on the first overload (line 0).
      expect(definition?.uri).toBe(TEST_URI);
      expect(definition?.range.start.line).toBe(0);
      expect(references.length).toBeGreaterThanOrEqual(2);
      expect(prepareRename?.placeholder).toBe("greet");
      const renameRanges = renameEdit?.changes?.[TEST_URI] ?? [];
      expect(renameRanges.length).toBe(references.length);
      expect(renameRanges.some((change) => change.range.start.line === 0)).toBe(true);
    });

    it("signature help selects the zero-parameter overload for a zero-argument call", async () => {
      const marked = sourceWithCursor(dedent`
        fun greet(): string { return "hi" }
        fun greet(name: string): string { return "Hello " + name }
        fun demo() { return greet(^^^) }
      `);
      const session = createAnalysisSession(marked.source);
      const help = await createSignatureHelp(session.ast!, session.analysis!, marked.line, marked.character);

      expect(help?.signatures.length).toBe(2);
      expect(help?.activeSignature).toBe(0);
      expect(help?.signatures[help!.activeSignature!]?.parameters?.length ?? -1).toBe(0);
    });

    it("signature help selects the one-parameter overload for a one-argument call", async () => {
      const marked = sourceWithCursor(dedent`
        fun greet(): string { return "hi" }
        fun greet(name: string): string { return "Hello " + name }
        fun demo() { return greet(^^^"world") }
      `);
      const session = createAnalysisSession(marked.source);
      const help = await createSignatureHelp(session.ast!, session.analysis!, marked.line, marked.character);

      expect(help?.signatures.length).toBe(2);
      expect(help?.activeSignature).toBe(1);
      expect(help?.signatures[help!.activeSignature!]?.label).toBe("greet(name: string): string");
    });
  });

  describe("runtime/ambient declaration scenario", () => {
    // `parseInt` is declared in the bundled ECMAScript runtime (es2025.d.ts).
    // Hover/definition/signature-help must resolve into that runtime
    // declaration file, while rename/prepareRename must reject it since the
    // declaration lives in a read-only virtual file (see
    // resolvePrepareRenameAcrossFiles/resolveRenameAcrossFiles guards in
    // crossFileNavigation.ts).
    it("hover, definition, and signature help resolve parseInt into the ECMAScript runtime declaration", async () => {
      await ensureEcmaScriptRuntimeProgram();
      const runtimeDeclarations = getEcmaScriptRuntimeProgram().body;

      const marked = sourceWithCursor(dedent`
        val result = par^^^seInt("42", 10)
      `);
      const root = await mkdtemp(join(tmpdir(), "vexa-lsp-unification-runtime-"));
      const file = join(root, "main.vx");
      await writeFile(file, marked.source, "utf8");

      const session = createAnalysisSession(marked.source, { ambientDeclarations: runtimeDeclarations });
      const context = {
        uri: pathToFileURL(file).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root]
      };

      const hover = await resolveHoverWithLocalFallback(context);
      const definition = await resolveDefinitionWithLocalFallback(context);

      expect(hover?.contents).toEqual(expect.objectContaining({ kind: "plaintext" }));
      const hoverValue = (hover?.contents as { value: string }).value;
      expect(hoverValue).toContain("function parseInt");

      // Definition jumps into the bundled runtime declaration file, not the
      // user's project file.
      expect(definition?.uri.endsWith("es2025.d.ts")).toBe(true);

      const sigMarked = sourceWithCursor(dedent`
        val result = parseInt(^^^"42", 10)
      `);
      const sigSession = createAnalysisSession(sigMarked.source, { ambientDeclarations: runtimeDeclarations });
      const signatureHelp = await createSignatureHelp(sigSession.ast!, sigSession.analysis!, sigMarked.line, sigMarked.character);

      expect(signatureHelp?.signatures.length).toBe(1);
      expect(signatureHelp?.signatures[0]?.label).toBe("parseInt(string: string, radix: number): number");
    });

    it("rename and prepareRename reject the runtime parseInt symbol", async () => {
      await ensureEcmaScriptRuntimeProgram();
      const runtimeDeclarations = getEcmaScriptRuntimeProgram().body;

      const marked = sourceWithCursor(dedent`
        val result = par^^^seInt("42", 10)
      `);
      const root = await mkdtemp(join(tmpdir(), "vexa-lsp-unification-runtime-rename-"));
      const file = join(root, "main.vx");
      await writeFile(file, marked.source, "utf8");

      const session = createAnalysisSession(marked.source, { ambientDeclarations: runtimeDeclarations });
      const context = {
        uri: pathToFileURL(file).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root]
      };

      const prepareRename = await resolvePrepareRenameAcrossFiles(context);
      const renameEdit = await resolveRenameAcrossFiles(context, "parseInteger");

      expect(prepareRename).toBeNull();
      expect(renameEdit).toBeNull();
    });
  });
});
