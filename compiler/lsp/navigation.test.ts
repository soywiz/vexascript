import { describe, expect, it } from "vitest";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { Analysis } from "compiler/analysis/Analysis";
import {
  createDefinitionLocation,
  createHover,
  createPrepareRename,
  createRenameWorkspaceEdit
} from "./navigation";

const URI = "file:///demo.my";

function analysisOf(source: string): Analysis {
  const ast = parseFile(tokenizeReader(source));
  return new Analysis(ast);
}

describe("lsp navigation", () => {
  it("resolves go-to-definition for variable usage", () => {
    const source = "let value = 1\nfun demo() {\n  let local = value\n  return local\n}\n";
    const analysis = analysisOf(source);

    const location = createDefinitionLocation(analysis, URI, 2, 16);
    expect(location).toEqual({
      uri: URI,
      range: {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 9 }
      }
    });
  });

  it("provides hover info for symbols and expressions", () => {
    const source = "let value = 1 + 2\n";
    const analysis = analysisOf(source);

    const symbolHover = createHover(analysis, 0, 5);
    expect(symbolHover?.contents).toEqual({
      kind: "plaintext",
      value: "variable value: int"
    });

    const expressionHover = createHover(analysis, 0, 12);
    expect(expressionHover?.contents).toEqual({
      kind: "plaintext",
      value: "expression: int"
    });
  });

  it("supports prepare rename and rename workspace edits", () => {
    const source = "fun demo() {\n  let local = 1\n  return local\n}\n";
    const analysis = analysisOf(source);

    const prepare = createPrepareRename(analysis, 1, 7);
    expect(prepare).toEqual({
      range: {
        start: { line: 1, character: 6 },
        end: { line: 1, character: 11 }
      },
      placeholder: "local"
    });

    const rename = createRenameWorkspaceEdit(analysis, URI, 1, 7, "renamed");
    expect(rename).toEqual({
      changes: {
        [URI]: [
          {
            range: {
              start: { line: 1, character: 6 },
              end: { line: 1, character: 11 }
            },
            newText: "renamed"
          },
          {
            range: {
              start: { line: 2, character: 9 },
              end: { line: 2, character: 14 }
            },
            newText: "renamed"
          }
        ]
      }
    });
  });

  it("does not allow rename for builtin symbols", () => {
    const source = "let a = true\n";
    const analysis = analysisOf(source);

    expect(createPrepareRename(analysis, 0, 9)).toBeNull();
    expect(createRenameWorkspaceEdit(analysis, URI, 0, 9, "yes")).toBeNull();
  });
});
