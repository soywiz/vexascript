import { BlockStatement, ClassStatement, ExportStatement, FunctionStatement, Identifier, NamespaceStatement, Program, VarStatement } from "compiler/ast/ast";
import { describe, expect, it } from "../test/expect";
import { buildNamespaceMemberCompletionItems, findNamespaceByPath } from "./memberCompletionNamespaces";
import type { Statement } from "compiler/ast/ast";

function makeNamespaceStatement(name: string, body: Statement[]): NamespaceStatement {
  return new NamespaceStatement("namespace", new BlockStatement(body), undefined, undefined, [new Identifier(name)]);
}

describe("memberCompletionNamespaces", () => {
  it("finds nested namespaces by path", () => {
    const ast = new Program([
        makeNamespaceStatement("pkg", [
          new ExportStatement(makeNamespaceStatement("tools", []))
        ])
      ]);

    const found = findNamespaceByPath(ast, ["pkg", "tools"]);
    expect(found?.names?.[0]?.name).toBe("tools");
  });

  it("builds namespace member completions for exported declarations", () => {
    const namespaceStatement = makeNamespaceStatement("pkg", [
      new ExportStatement(new VarStatement("let", new Identifier("value"))),
      new ExportStatement(new FunctionStatement("function", new Identifier("helper"), [], new BlockStatement([]))),
      new ExportStatement(new ClassStatement(new Identifier("Box"), [])),
      new ExportStatement(makeNamespaceStatement("tools", []))
    ]);

    const items = buildNamespaceMemberCompletionItems(namespaceStatement!, "");
    const labels = items.map((item) => item.label);

    expect(labels).toContain("value");
    expect(labels).toContain("helper");
    expect(labels).toContain("Box");
    expect(labels).toContain("tools");
  });
});
