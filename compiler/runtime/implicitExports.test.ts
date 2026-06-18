import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { collectImplicitVexaExportPlan } from "./implicitExports";

describe("collectImplicitVexaExportPlan", () => {
  it("builds one shared export plan for ESM and CommonJS implicit Vexa exports", () => {
    const program = parseFile(tokenizeReader(dedent`
      class Box
      fun render(value: number) => value
      fun render(value: string) => value
      @JsName("countImpl")
      fun count() => 1
      var string.background: string {
        get { return this }
        set { console.log(newValue) }
      }
      val plain = 1
    `));

    const plan = collectImplicitVexaExportPlan(program, "/virtual/main.vx");

    expect(plan.esmSpecifiers).toEqual([
      "Box",
      "render$$number",
      "render$$string",
      "countImpl as count",
      "string$$background",
      "string$$background$set",
      "plain"
    ]);
    expect(plan.commonJsLines).toEqual([
      "exports.Box = Box;",
      "exports.render$$number = render$$number;",
      "exports.render$$string = render$$string;",
      "exports.count = countImpl;",
      "exports.string$$background = string$$background;",
      "exports.string$$background$set = string$$background$set;",
      "exports.plain = plain;"
    ]);
  });

  it("returns an empty plan for non-.vx modules", () => {
    const program = parseFile(tokenizeReader("export const value = 1"), { language: "typescript" });
    expect(collectImplicitVexaExportPlan(program, "/virtual/helpers.ts")).toEqual({
      esmSpecifiers: [],
      commonJsLines: []
    });
  });
});
