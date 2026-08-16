import { describe, expect, it } from "../test/expect";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { buildAnalysisForSource } from "./analysisSession";
import { createDocumentHighlights, createFoldingRanges, createOnTypeFormattingEdits, createReferenceCodeLenses, createSelectionRanges, prepareCallHierarchy, createIncomingCalls, createOutgoingCalls } from "./documentFeatures";
import { sourceWithCursor } from "../test/sourceWithCursor";

const parse = (source: string) => parseFile(tokenizeReader(source, { jsx: true }));

describe("LSP document features", () => {
  it("highlights a symbol declaration and its references", () => {
    const analysis = buildAnalysisForSource("let value = 1\nvalue + value\n")!;
    expect(createDocumentHighlights(analysis, 1, 1)).toHaveLength(3);
  });

  it("keeps delegated variable highlights across nested functions and object shorthand", () => {
    const { source, line, character } = sourceWithCursor([
      "func App() {",
      "  let count by useState(0)",
      "  func increment() { count++ }",
      "  const counter = useMemo(() => {",
      "    return { cou^^^nt, increment }",
      "  }, [count])",
      "}"
    ].join("\n"));
    const analysis = buildAnalysisForSource(source)!;

    const highlights = createDocumentHighlights(analysis, line, character);

    expect(highlights).toHaveLength(4);
    expect(highlights.every((highlight) => highlight.kind === 3)).toBe(true);
  });

  it("creates folding ranges for multiline structural nodes", () => {
    const ranges = createFoldingRanges(parse("class Box {\n  run() {\n    return 1\n  }\n}\n"));
    expect(ranges.map((range) => [range.startLine, range.endLine])).toContainEqual([0, 4]);
    expect(ranges.map((range) => [range.startLine, range.endLine])).toContainEqual([1, 3]);
  });

  it("creates folding ranges for multiline JSX tags and fragments", () => {
    const ranges = createFoldingRanges(parse("fun view(props: any) {\n  val element = <section>\n    <header>\n      <span />\n    </header>\n  </section>\n  val fragment = <>\n    <span {...props}/>\n  </>\n}\n"));
    expect(ranges.map((range) => [range.startLine, range.endLine])).toContainEqual([1, 5]);
    expect(ranges.map((range) => [range.startLine, range.endLine])).toContainEqual([2, 4]);
    expect(ranges.map((range) => [range.startLine, range.endLine])).toContainEqual([6, 8]);
  });

  it("creates nested selection ranges", () => {
    const selection = createSelectionRanges(parse("fun add() { return 1 + 2 }\n"), [{ line: 0, character: 21 }])[0]!;
    expect(selection.parent).toBeDefined();
    expect(selection.range.start.line).toBe(0);
  });

  it("creates reference code lenses for top-level declarations", () => {
    const source = "fun add() {}\nadd()\n";
    const lenses = createReferenceCodeLenses(parse(source), buildAnalysisForSource(source)!, "file:///test.vx");
    expect(lenses[0]?.command?.title).toBe("1 reference");
    expect(lenses[0]?.command?.command).toBe("vexa.showReferences");
  });

  it("builds same-document call hierarchy", () => {
    const ast = parse("fun target() {}\nfun caller() { target() }\n");
    const target = prepareCallHierarchy(ast, "file:///test.vx", { line: 0, character: 5 })![0]!;
    const caller = prepareCallHierarchy(ast, "file:///test.vx", { line: 1, character: 5 })![0]!;
    expect(createOutgoingCalls(ast, "file:///test.vx", caller)[0]?.to.name).toBe("target");
    expect(createIncomingCalls(ast, "file:///test.vx", target)[0]?.from.name).toBe("caller");
  });

  it("indents after an opening brace during on-type formatting", () => {
    expect(createOnTypeFormattingEdits("fun test() {\n", { line: 1, character: 0 }, "\n")[0]?.newText).toBe("  ");
  });

  it("closes JSX opening tags after typing the angle bracket", () => {
    const source = "return <SignalCounter>";
    const edits = createOnTypeFormattingEdits(source, { line: 0, character: source.length }, ">");

    expect(edits).toEqual([{
      range: {
        start: { line: 0, character: source.length },
        end: { line: 0, character: source.length }
      },
      newText: "</SignalCounter>"
    }]);

    const intrinsic = "return <div>";
    expect(createOnTypeFormattingEdits(intrinsic, { line: 0, character: intrinsic.length }, ">")[0]?.newText).toBe("</div>");
  });

  it("does not confuse a later unrelated JSX closing tag with the tag being typed", () => {
    const source = [
      "return (",
      "  <button>",
      "    <div>",
      "  </button>",
      ")",
      "func Other() {",
      "  return <div>other</div>",
      "}"
    ].join("\n");

    expect(createOnTypeFormattingEdits(source, { line: 2, character: 9 }, ">")[0]?.newText).toBe("</div>");
  });

  it("does not close self-closing, closing, or already-closed JSX tags", () => {
    const selfClosing = "return <SignalCounter />";
    const closing = "return </SignalCounter>";
    const alreadyClosed = "return <SignalCounter>child</SignalCounter>";
    const nestedAlreadyClosed = "return <div><span>child</span></div>";
    expect(createOnTypeFormattingEdits(selfClosing, { line: 0, character: selfClosing.length }, ">")).toEqual([]);
    expect(createOnTypeFormattingEdits(closing, { line: 0, character: closing.length }, ">")).toEqual([]);
    expect(createOnTypeFormattingEdits(alreadyClosed, { line: 0, character: "return <SignalCounter>".length }, ">")).toEqual([]);
    expect(createOnTypeFormattingEdits(nestedAlreadyClosed, { line: 0, character: "return <div>".length }, ">")).toEqual([]);
  });

  it("does not treat comparisons, strings, or comments as JSX tags", () => {
    const comparison = "value < other >";
    expect(createOnTypeFormattingEdits(comparison, { line: 0, character: comparison.length }, ">")).toEqual([]);
    const compactComparison = "value <other>";
    expect(createOnTypeFormattingEdits(compactComparison, { line: 0, character: compactComparison.length }, ">")).toEqual([]);
    expect(createOnTypeFormattingEdits('const text = "<other>"', { line: 0, character: 22 }, ">")).toEqual([]);
    expect(createOnTypeFormattingEdits("// <other>", { line: 0, character: 10 }, ">")).toEqual([]);
  });

  it("keeps closing nested JSX tags after apostrophes in JSX text", () => {
    const source = "return <div>it's <span>";
    expect(createOnTypeFormattingEdits(source, { line: 0, character: source.length }, ">")[0]?.newText).toBe("</span>");
  });
});
