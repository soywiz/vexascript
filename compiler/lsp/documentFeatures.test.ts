import { describe, expect, it } from "vitest";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { buildAnalysisForSource } from "./analysisSession";
import { createDocumentHighlights, createFoldingRanges, createOnTypeFormattingEdits, createReferenceCodeLenses, createSelectionRanges, prepareCallHierarchy, createIncomingCalls, createOutgoingCalls } from "./documentFeatures";

const parse = (source: string) => parseFile(tokenizeReader(source));

describe("LSP document features", () => {
  it("highlights a symbol declaration and its references", () => {
    const analysis = buildAnalysisForSource("let value = 1\nvalue + value\n")!;
    expect(createDocumentHighlights(analysis, 1, 1)).toHaveLength(3);
  });

  it("creates folding ranges for multiline structural nodes", () => {
    const ranges = createFoldingRanges(parse("class Box {\n  run() {\n    return 1\n  }\n}\n"));
    expect(ranges.map((range) => [range.startLine, range.endLine])).toContainEqual([0, 4]);
    expect(ranges.map((range) => [range.startLine, range.endLine])).toContainEqual([1, 3]);
  });

  it("creates nested selection ranges", () => {
    const selection = createSelectionRanges(parse("fun add() { return 1 + 2 }\n"), [{ line: 0, character: 21 }])[0]!;
    expect(selection.parent).toBeDefined();
    expect(selection.range.start.line).toBe(0);
  });

  it("creates reference code lenses for top-level declarations", () => {
    const source = "fun add() {}\nadd()\n";
    const lenses = createReferenceCodeLenses(parse(source), buildAnalysisForSource(source)!, "file:///test.my");
    expect(lenses[0]?.command?.title).toBe("1 reference");
  });

  it("builds same-document call hierarchy", () => {
    const ast = parse("fun target() {}\nfun caller() { target() }\n");
    const target = prepareCallHierarchy(ast, "file:///test.my", { line: 0, character: 5 })![0]!;
    const caller = prepareCallHierarchy(ast, "file:///test.my", { line: 1, character: 5 })![0]!;
    expect(createOutgoingCalls(ast, "file:///test.my", caller)[0]?.to.name).toBe("target");
    expect(createIncomingCalls(ast, "file:///test.my", target)[0]?.from.name).toBe("caller");
  });

  it("indents after an opening brace during on-type formatting", () => {
    expect(createOnTypeFormattingEdits("fun test() {\n", { line: 1, character: 0 }, "\n")[0]?.newText).toBe("  ");
  });
});
