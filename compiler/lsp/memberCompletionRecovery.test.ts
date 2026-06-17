import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { COMPLETION_RECOVERY_MEMBER, CompletionItemKind } from "./completionModel";
import {
  collectAmbientInterfaceCompletionMembers,
  recoverSourceForMemberAccessCompletion
} from "./memberCompletionRecovery";

describe("memberCompletionRecovery", () => {
  it("collects interface members from ambient declarations and exported ambient declarations", () => {
    const ast = parseFile(tokenizeReader(dedent`
      declare interface Document {
        body: HTMLElement
        querySelector(selector: string): Element?
      }
      export interface Window {
        document: Document
      }
    `));

    expect(collectAmbientInterfaceCompletionMembers(ast.body, "Document")).toEqual([
      {
        name: "body",
        detail: "Interface property: HTMLElement",
        kind: CompletionItemKind.Field
      },
      {
        name: "querySelector",
        detail: "Interface method: Element?",
        kind: CompletionItemKind.Method
      }
    ]);

    expect(collectAmbientInterfaceCompletionMembers(ast.body, "Window")).toEqual([
      {
        name: "document",
        detail: "Interface property: Document",
        kind: CompletionItemKind.Field
      }
    ]);
  });

  it("injects the recovery member in place of the typed prefix for member access", () => {
    const source = dedent`
      fun demo() {
        box.val
      }
    `;

    expect(recoverSourceForMemberAccessCompletion(source, 1, 7)).toContain(`box.${COMPLETION_RECOVERY_MEMBER}`);
  });

  it("returns null when the cursor is not in a member-access completion position", () => {
    expect(recoverSourceForMemberAccessCompletion("fun demo() {}", 0, 4)).toBe(null);
  });
});
