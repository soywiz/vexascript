import { NodeKind } from "compiler/ast/ast";
import { describe, expect, it } from "../test/expect";
import { buildNamespaceMemberCompletionItems, findNamespaceByPath } from "./memberCompletionNamespaces";
import type { NamespaceStatement, Program } from "compiler/ast/ast";

function makeNamespaceStatement(name: string, body: any[]): NamespaceStatement {
  return {
    kind: NodeKind.NamespaceStatement,
    declarationKind: "namespace",
    names: [{ kind: NodeKind.Identifier, name }],
    body: {
      kind: NodeKind.Program,
      body
    }
  } as unknown as NamespaceStatement;
}

describe("memberCompletionNamespaces", () => {
  it("finds nested namespaces by path", () => {
    const ast = {
      kind: NodeKind.Program,
      body: [
        makeNamespaceStatement("pkg", [
          {
            kind: NodeKind.ExportStatement,
            declaration: makeNamespaceStatement("tools", [])
          }
        ])
      ]
    } as Program;

    const found = findNamespaceByPath(ast, ["pkg", "tools"]);
    expect(found?.names?.[0]?.name).toBe("tools");
  });

  it("builds namespace member completions for exported declarations", () => {
    const namespaceStatement = makeNamespaceStatement("pkg", [
      {
        kind: NodeKind.ExportStatement,
        declaration: {
          kind: NodeKind.VarStatement,
          name: { kind: NodeKind.Identifier, name: "value" }
        }
      },
      {
        kind: NodeKind.ExportStatement,
        declaration: {
          kind: NodeKind.FunctionStatement,
          name: { kind: NodeKind.Identifier, name: "helper" }
        }
      },
      {
        kind: NodeKind.ExportStatement,
        declaration: {
          kind: NodeKind.ClassStatement,
          name: { kind: NodeKind.Identifier, name: "Box" }
        }
      },
      {
        kind: NodeKind.ExportStatement,
        declaration: makeNamespaceStatement("tools", [])
      }
    ] as any[]);

    const items = buildNamespaceMemberCompletionItems(namespaceStatement!, "");
    const labels = items.map((item) => item.label);

    expect(labels).toContain("value");
    expect(labels).toContain("helper");
    expect(labels).toContain("Box");
    expect(labels).toContain("tools");
  });
});
