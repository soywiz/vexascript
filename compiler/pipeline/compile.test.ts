import { describe, expect, it } from "vitest";
import {
  compileSource,
  formatParseIssue,
  formatSemanticIssue
} from "./compile";

describe("compileSource", () => {
  it("produces parse and semantic artifacts for valid source", () => {
    const source = "let a = 1\nlet b = a + 2\n";
    const artifacts = compileSource(source);

    expect(artifacts.ast).not.toBeNull();
    expect(artifacts.analysis).not.toBeNull();
    expect(artifacts.parserIssues).toEqual([]);
    expect(artifacts.semanticIssues).toEqual([]);
    expect(artifacts.tokenizeError).toBeNull();
    expect(artifacts.fatalError).toBeNull();
  });

  it("passes parser language options through compilation", () => {
    const artifacts = compileSource("export = value;", { language: "typescript" });

    expect(artifacts.ast).not.toBeNull();
    expect(artifacts.parserIssues).toEqual([]);
    expect(artifacts.analysis).not.toBeNull();
  });

  it("keeps parser issues and still runs semantic analysis on recovered ast", () => {
    const source = "let = 1\nlet ok = missing\n";
    const artifacts = compileSource(source);

    expect(artifacts.ast).not.toBeNull();
    expect(artifacts.parserIssues.length).toBeGreaterThan(0);
    expect(artifacts.analysis).not.toBeNull();
    expect(artifacts.semanticIssues.map((issue) => issue.message)).toContain(
      "Undefined variable 'missing'"
    );
  });

  it("captures tokenize errors without ast/artifacts", () => {
    const artifacts = compileSource("\"unterminated");

    expect(artifacts.ast).toBeNull();
    expect(artifacts.analysis).toBeNull();
    expect(artifacts.tokenizeError).not.toBeNull();
    expect(artifacts.parserIssues).toEqual([]);
    expect(artifacts.semanticIssues).toEqual([]);
  });

  it("formats parse and semantic issues with line/column", () => {
    const source = "let = 1\nlet ok = missing\n";
    const artifacts = compileSource(source);

    const parseMessage = artifacts.parserIssues[0] ? formatParseIssue(artifacts.parserIssues[0]) : "";
    const semaMessage = artifacts.semanticIssues[0]
      ? formatSemanticIssue(artifacts.semanticIssues[0])
      : "";

    expect(parseMessage).toContain(" at ");
    expect(semaMessage).toContain(" at ");
  });
});
