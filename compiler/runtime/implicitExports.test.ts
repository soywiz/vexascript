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

  it("re-exports extension operator overloads under their emitted runtime names", () => {
    // Regression: the implicit export planner and the emitter once kept two
    // separate operator->method-name maps that disagreed for *, /, %, <, >, <=,
    // >=, ||, &&, ??. That made a `.vx` module export an operator overload under
    // a name the function was never emitted with (e.g. `operator$multiply` while
    // the emitter produced `operator$star`), so a cross-module call could not
    // resolve. Both now share `operatorBaseRuntimeName`, so the exported name
    // must equal the emitter's mangled name (`operator$star`, ...).
    const program = parseFile(tokenizeReader(dedent`
      class Vec2(val x: number, val y: number)
      fun Vec2.operator*(other: Vec2) => Vec2(x * other.x, y * other.y)
      fun Vec2.operator/(other: Vec2) => Vec2(x / other.x, y / other.y)
      fun Vec2.operator%(other: Vec2) => Vec2(x % other.x, y % other.y)
      fun Vec2.operator<(other: Vec2): boolean => x < other.x
      fun Vec2.operator||(other: Vec2): boolean => x != 0.0 || other.x != 0.0
      fun Vec2.operator??(other: Vec2) => other
    `));

    const plan = collectImplicitVexaExportPlan(program, "/virtual/vec.vx");

    expect(plan.esmSpecifiers).toEqual([
      "Vec2",
      "Vec2$$operator$star$$Vec2",
      "Vec2$$operator$slash$$Vec2",
      "Vec2$$operator$percent$$Vec2",
      "Vec2$$operator$less$$Vec2",
      "Vec2$$operator$logicalOr$$Vec2",
      "Vec2$$operator$nullish$$Vec2"
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
