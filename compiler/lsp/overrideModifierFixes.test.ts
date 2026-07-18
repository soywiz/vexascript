import { NodeKind } from "compiler/ast/ast";
import { describe, expect, it, pathToFileURL } from "../test/expect";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import type { ClassStatement } from "compiler/ast/ast";
import { VEXA_DIAGNOSTIC_CODES } from "./diagnosticCodes";
import { createOverrideModifierCodeActions } from "./overrideModifierFixes";

describe("override modifier quick fix", () => {
  it("inserts 'override' before a member implementing a project supertype member", () => {
    const source = [
      "interface Sample {",
      "  fun lol2()",
      "}",
      "class Demo implements Sample {",
      "  fun lol2(): void {",
      "  }",
      "}",
      ""
    ].join("\n");
    const ast = parseFile(tokenizeReader(source));

    const demo = ast.body.find(
      (statement): statement is ClassStatement =>
        statement.kind === NodeKind.ClassStatement && (statement as ClassStatement).name.name === "Demo"
    )!;
    const member = demo.members.find((candidate) => candidate.name.name === "lol2")!;
    const nameToken = member.name.firstToken!;

    const diagnostic: Diagnostic = {
      severity: 1,
      source: "vexa-sema",
      code: VEXA_DIAGNOSTIC_CODES.MISSING_OVERRIDE_MODIFIER,
      message: "Member 'lol2' must be declared with 'override' because it overrides a member from a base class or interface",
      range: {
        start: { line: nameToken.range.start.line, character: nameToken.range.start.column },
        end: { line: nameToken.range.end.line, character: nameToken.range.end.column }
      }
    };

    const uri = pathToFileURL("/demo.vx").toString();
    const actions = createOverrideModifierCodeActions({ uri, ast, diagnostics: [diagnostic] });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Add 'override' to 'lol2'");
    const edit = actions[0]?.edit?.changes?.[uri]?.[0];
    expect(edit?.newText).toBe("override ");
    // Inserted at the start of the member declaration (the `fun` keyword).
    expect(edit?.range.start).toEqual({
      line: member.firstToken!.range.start.line,
      character: member.firstToken!.range.start.column
    });
    expect(edit?.range.end).toEqual(edit?.range.start);
  });

  it("ignores diagnostics without the missing-override code", () => {
    const ast = parseFile(tokenizeReader("class Demo {\n}\n"));
    const uri = pathToFileURL("/demo.vx").toString();
    const actions = createOverrideModifierCodeActions({
      uri,
      ast,
      diagnostics: [
        {
          severity: 1,
          source: "vexa-sema",
          message: "unrelated",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
        }
      ]
    });
    expect(actions).toEqual([]);
  });
});
