import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import type { ClassStatement, EnumStatement } from "compiler/ast/ast";
import { createAnalysisSession } from "./analysisSession";
import { createClassResolverCache } from "./classResolver";
import { CompletionItemKind } from "./completionModel";
import {
  buildClassMemberCompletionItems,
  buildEnumMemberCompletionItems,
  buildInterfaceMemberCompletionItems,
  operatorSymbolFromMemberName
} from "./memberCompletionItemBuilders";

describe("memberCompletionItemBuilders", () => {
  it("builds class member items with constructor properties first and operator edits", async () => {
    const session = createAnalysisSession(dedent`
      class Point(val x: int, y: int) {
        scale: int = 1
        sum() => x + y
        operator+(other: Point): Point => this
      }
    `);
    const classStatement = session.ast?.body[0];
    if (!classStatement || classStatement.kind !== "ClassStatement") {
      throw new Error("Expected class statement");
    }
    const pointClass = classStatement as ClassStatement;

    const items = await buildClassMemberCompletionItems(
      pointClass,
      "Point",
      "",
      session.analysis!,
      {
        line: 0,
        dotCharacter: 10,
        prefixEndCharacter: 18
      },
      {
        ast: session.ast!,
        options: {},
        cache: createClassResolverCache()
      }
    );
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("x")?.sortText).toBe("0-x");
    expect(byLabel.get("scale")?.sortText).toBe("1-scale");
    expect(byLabel.get("sum")?.sortText).toBe("2-sum");
    expect(byLabel.get("operator+")?.textEdit?.newText).toBe(" + ");
    expect(byLabel.get("operator+")?.additionalTextEdits?.[0]?.newText).toBe("");
  });

  it("filters and deduplicates interface-like member items", () => {
    const items = buildInterfaceMemberCompletionItems("to", [
      { name: "toString", detail: "Interface method: string", kind: CompletionItemKind.Method },
      { name: "toString", detail: "Interface method: string", kind: CompletionItemKind.Method },
      { name: "valueOf", detail: "Interface method: number", kind: CompletionItemKind.Method }
    ]);

    expect(items).toEqual([
      {
        label: "toString",
        kind: CompletionItemKind.Method,
        detail: "Interface method: string",
        sortText: "2-toString"
      }
    ]);
  });

  it("filters enum members by prefix and exposes enum details", () => {
    const session = createAnalysisSession(dedent`
      enum Demo {
        HELLO,
        WORLD
      }
    `);
    const enumStatement = session.ast?.body[0];
    if (!enumStatement || enumStatement.kind !== "EnumStatement") {
      throw new Error("Expected enum statement");
    }
    const demoEnum = enumStatement as EnumStatement;

    expect(buildEnumMemberCompletionItems(demoEnum, "HE")).toEqual([
      {
        label: "HELLO",
        kind: CompletionItemKind.EnumMember,
        detail: "Enum member: Demo",
        sortText: "2-HELLO"
      }
    ]);
  });

  it("extracts operator symbols from operator member names", () => {
    expect(operatorSymbolFromMemberName("operator+")).toBe("+");
    expect(operatorSymbolFromMemberName("sum")).toBe(null);
  });
});
