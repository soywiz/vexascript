import { NodeKind } from "compiler/ast/ast";
import { describe, expect, it } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import type { Identifier } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { createAnalysisSession } from "./analysisSession";
import {
  declaredInitializerTypeName,
  explicitTypeNameFromNewExpression,
  inferredTypeNameLosesGenericArguments,
  typeNameFromAnalysisType
} from "./classResolverTypeNames";
import { containsPosition, nodeRange } from "./ranges";

describe("classResolverTypeNames", () => {
  it("renders builtin and named analysis types as type names", () => {
    const { source, line, character } = sourceWithCursor("let value = 1\nlet copy = val^^^ue\n");
    const session = createAnalysisSession(source);
    const symbol = session.analysis!.getSymbolAt(line, character)?.symbol;

    expect(typeNameFromAnalysisType(symbol?.type)).toBe("int");
    expect(typeNameFromAnalysisType(undefined)).toBeNull();
  });

  it("extracts explicit type names from generic new expressions", () => {
    const source = "let list = new Box<string>()\n";
    const ast = parseFile(tokenizeReader(source));
    const initializer = (ast.body[0] as import("compiler/ast/ast").VarStatement).initializer as import("compiler/ast/ast").NewExpression;

    expect(explicitTypeNameFromNewExpression(initializer)).toBe("Box<string>");
  });

  it("detects lossy generic any placeholders", () => {
    expect(inferredTypeNameLosesGenericArguments("Box<any>")).toBe(true);
    expect(inferredTypeNameLosesGenericArguments("Map<any, any>")).toBe(true);
    expect(inferredTypeNameLosesGenericArguments("Box<string>")).toBe(false);
    expect(inferredTypeNameLosesGenericArguments(null)).toBe(true);
  });

  it("recovers declared initializer type names from bound identifiers", () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Box<T>
      let val^^^ue = new Box<string>()
    `);
    const ast = parseFile(tokenizeReader(source));
    let identifier: Identifier | null = null;
    walkAst(ast, (node) => {
      if (identifier || node.kind !== NodeKind.Identifier) {
        return;
      }
      const range = nodeRange(node);
      if (range && containsPosition(range, { line, character })) {
        identifier = node as Identifier;
      }
    });

    expect(declaredInitializerTypeName(identifier!, ast)).toBe("Box<string>");
  });
});
