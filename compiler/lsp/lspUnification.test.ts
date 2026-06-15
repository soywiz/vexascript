/**
 * Cross-feature LSP unification tests.
 *
 * Verifies that hover, definition, and references agree on the same canonical
 * symbol, and that new unified entrypoints (resolveHoverWithLocalFallback,
 * resolveImportSpecifierDefinition) work correctly.
 */
import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import dedent from "compiler/utils/dedent";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { Analysis } from "compiler/analysis/Analysis";
import { createAnalysisSession } from "./analysisSession";
import {
  createHover,
  createDefinitionLocation,
  createReferences
} from "./navigation";
import {
  resolveDefinitionWithLocalFallback,
  resolveHoverWithLocalFallback
} from "./crossFileNavigation";

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
});
