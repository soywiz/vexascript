import { describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  AnalysisSessionCache,
  buildAnalysisForSource,
  createAnalysisSession
} from "./analysisSession";

describe("lsp analysis session", () => {
  it("builds analysis even when parser recovered from syntax errors", () => {
    const source =
      "let = 1\n" +
      "let ok = 1\n" +
      "fun demo() {\n" +
      "  return ok\n" +
      "}\n";

    const analysis = buildAnalysisForSource(source);
    expect(analysis).not.toBeNull();
    expect(analysis?.getDefinitionAt(3, 9)?.symbol.name).toBe("ok");
  });

  it("returns null when source cannot be tokenized", () => {
    const analysis = buildAnalysisForSource("\"unterminated");
    expect(analysis).toBeNull();
  });

  it("captures parser errors while still exposing ast and semantic analysis", () => {
    const source = "let = 1\nlet ok = missing\n";
    const session = createAnalysisSession(source);

    expect(session.ast).not.toBeNull();
    expect(session.parserErrors.length).toBeGreaterThan(0);
    expect(session.analysis).not.toBeNull();
    expect(session.semanticIssues.some((issue) => issue.message.includes("'missing'"))).toBe(true);
    expect(session.analysis?.getIssues()).toEqual(session.semanticIssues);
    expect(session.tokenizeError).toBeNull();
  });

  it("reuses cached session for same uri+version and rebuilds on version change", () => {
    const cache = new AnalysisSessionCache();
    const uri = "file:///demo.my";
    const docV1 = TextDocument.create(uri, "mylang", 1, "let a = 1\n");
    const docV2 = TextDocument.create(uri, "mylang", 2, "let a = 2\n");

    const sessionV1First = cache.getForDocument(docV1);
    const sessionV1Second = cache.getForDocument(docV1);
    const sessionV2 = cache.getForDocument(docV2);

    expect(sessionV1First).toBe(sessionV1Second);
    expect(sessionV2).not.toBe(sessionV1First);
  });
});
