import { describe, expect, it } from "../test/expect";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import type { FunctionStatement, VarStatement } from "compiler/ast/ast";
import { createAnalysisSession } from "./analysisSession";
import {
  extensionBindingNames,
  extensionReceiverMatches,
  inferExtensionReturnTypeName
} from "./memberCompletionExtensions";

describe("memberCompletionExtensions", () => {
  it("matches extension receivers against normalized and array-shaped type names", () => {
    expect(extensionReceiverMatches("Point", "Point")).toBe(true);
    expect(extensionReceiverMatches("number", "int")).toBe(true);
    expect(extensionReceiverMatches("Array", "int[]")).toBe(true);
    expect(extensionReceiverMatches("Point", "Other")).toBe(false);
  });

  it("collects binding names from direct and declarator-based extension properties", () => {
    const singleAst = parseFile(tokenizeReader("val number.length: int => 1\n"));
    const declaratorAst = parseFile(tokenizeReader("val left = 1, right = 2\n"));

    expect(extensionBindingNames(singleAst.body[0] as VarStatement)).toEqual(["length"]);
    expect(extensionBindingNames(declaratorAst.body[0] as VarStatement)).toEqual(["left", "right"]);
  });

  it("infers extension return types from annotations, analysis, constructors, and functions", () => {
    const typedSession = createAnalysisSession("val number.size: int => 1\n");
    const typedStatement = typedSession.ast!.body[0] as VarStatement;

    const inferredSession = createAnalysisSession("val number.size => 1\n");
    const inferredStatement = inferredSession.ast!.body[0] as VarStatement;

    const constructedSession = createAnalysisSession("class Box\nval number.box => new Box()\n");
    const constructedStatement = constructedSession.ast!.body[1] as VarStatement;

    const functionAst = parseFile(tokenizeReader("fun number.label(): string => \"ok\"\n"));
    const functionStatement = functionAst.body[0] as FunctionStatement;

    expect(inferExtensionReturnTypeName(typedStatement, typedSession.analysis!)).toBe("int");
    expect(inferExtensionReturnTypeName(inferredStatement, inferredSession.analysis!)).toBe("int");
    expect(inferExtensionReturnTypeName(constructedStatement, constructedSession.analysis!)).toBe("Box");
    expect(inferExtensionReturnTypeName(functionStatement, null)).toBe("string");
  });
});
