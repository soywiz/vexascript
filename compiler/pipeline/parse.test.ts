import { describe, it } from "node:test";
import { expect } from "../../vitest";
import { parseSource } from "./parse";

describe("parseSource", () => {
  it("produces parser artifacts without requiring semantic analysis", () => {
    const artifacts = parseSource("let value = missing\n");

    expect(artifacts.ast).not.toBeNull();
    expect(artifacts.parserIssues).toEqual([]);
    expect(artifacts.tokenizeError).toBeNull();
    expect(artifacts.fatalError).toBeNull();
    expect(artifacts).not.toHaveProperty("analysis");
    expect(artifacts).not.toHaveProperty("semanticIssues");
  });

  it("passes parser language options through the shared pipeline", () => {
    const source = "export = value;";

    expect(parseSource(source).parserIssues.length).toBeGreaterThan(0);
    expect(parseSource(source, { language: "typescript" }).parserIssues).toEqual([]);
  });

  it("captures tokenizer failures as parser artifacts", () => {
    const artifacts = parseSource("\"unterminated");

    expect(artifacts.ast).toBeNull();
    expect(artifacts.parserIssues).toEqual([]);
    expect(artifacts.tokenizeError).not.toBeNull();
    expect(artifacts.fatalError).toBeNull();
  });
});
