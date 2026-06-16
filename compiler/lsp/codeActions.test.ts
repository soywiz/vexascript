import { describe, expect, it } from "../test/expect";
import type { CodeAction } from "vscode-languageserver/node.js";
import { deferCodeActions, resolveDeferredCodeAction } from "./codeActions";

const URI = "file:///demo.vx";

describe("deferred code actions", () => {
  it("defers edits into data and restores them in resolve", () => {
    const original: CodeAction = {
      title: "Replace 'let' with 'const'",
      kind: "quickfix",
      edit: {
        changes: {
          [URI]: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 3 }
              },
              newText: "const"
            }
          ]
        }
      }
    };

    const deferred = deferCodeActions([original])[0]!;
    expect(deferred.edit).toBeUndefined();
    expect(deferred.data).toBeDefined();

    const resolved = resolveDeferredCodeAction(deferred);
    expect(resolved.edit).toEqual(original.edit);
  });

  it("preserves existing action data through defer and resolve", () => {
    const original: CodeAction = {
      title: "Import 'Point' from './a.vx'",
      kind: "quickfix",
      data: {
        existing: true
      },
      edit: {
        changes: {
          [URI]: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 }
              },
              newText: "import { Point } from \"./a.vx\"\n"
            }
          ]
        }
      }
    };

    const deferred = deferCodeActions([original])[0]!;
    expect(deferred.edit).toBeUndefined();

    const resolved = resolveDeferredCodeAction(deferred);
    expect(resolved.data).toEqual(original.data);
    expect(resolved.edit).toEqual(original.edit);
  });

  it("leaves actions without edits untouched", () => {
    const original: CodeAction = {
      title: "No-op",
      kind: "quickfix"
    };

    const deferred = deferCodeActions([original])[0]!;
    expect(deferred).toEqual(original);
    expect(resolveDeferredCodeAction(deferred)).toEqual(original);
  });
});
