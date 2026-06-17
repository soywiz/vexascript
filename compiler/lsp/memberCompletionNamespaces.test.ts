import { describe, expect, it } from "../test/expect";
import { buildNamespaceMemberCompletionItems, findNamespaceByPath } from "./memberCompletionNamespaces";
import type { NamespaceStatement, Program } from "compiler/ast/ast";

function makeNamespaceStatement(name: string, body: any[]): NamespaceStatement {
  return {
    kind: "NamespaceStatement",
    declarationKind: "namespace",
    names: [{ kind: "Identifier", name }],
    body: {
      kind: "Program",
      body
    }
  } as unknown as NamespaceStatement;
}

describe("memberCompletionNamespaces", () => {
  it("finds nested namespaces by path", () => {
    const ast = {
      kind: "Program",
      body: [
        makeNamespaceStatement("pkg", [
          {
            kind: "ExportStatement",
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
        kind: "ExportStatement",
        declaration: {
          kind: "VarStatement",
          name: { kind: "Identifier", name: "value" }
        }
      },
      {
        kind: "ExportStatement",
        declaration: {
          kind: "FunctionStatement",
          name: { kind: "Identifier", name: "helper" }
        }
      },
      {
        kind: "ExportStatement",
        declaration: {
          kind: "ClassStatement",
          name: { kind: "Identifier", name: "Box" }
        }
      },
      {
        kind: "ExportStatement",
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
