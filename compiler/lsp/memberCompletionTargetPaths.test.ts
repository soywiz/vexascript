import { NodeKind } from "compiler/ast/ast";
import { describe, expect, it, pathToFileURL } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import type { NamespaceStatement, Program } from "compiler/ast/ast";
import { createAnalysisSession } from "./analysisSession";
import { createClassResolverCache } from "./classResolver";
import { parseMemberAccessTarget } from "./memberCompletionParsing";
import { buildTargetPathMemberAccessCompletions } from "./memberCompletionTargetPaths";
import { resolveExtensionMemberTypeName } from "./memberCompletionExtensionMembers";
import { buildMemberCompletionItemsForType } from "./memberCompletion";

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

describe("memberCompletionTargetPaths", () => {
  it("suppresses member completions after enum-qualified access paths", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      enum Axis { x, y }
      Axis.x.^^^
    `);
    const session = createAnalysisSession(source);
    const target = parseMemberAccessTarget(source, line, character);

    const result = await buildTargetPathMemberAccessCompletions(
      session.ast!,
      session.analysis!,
      target!,
      line,
      character,
      { text: source },
      {},
      createClassResolverCache(),
      resolveExtensionMemberTypeName,
      buildMemberCompletionItemsForType
    );

    expect(result).toEqual({
      items: [],
      shouldRecoverOnEmpty: false
    });
  });

  it("builds namespace member completions for parsed object paths", async () => {
    const session = createAnalysisSession("");
    const ast = {
      kind: NodeKind.Program,
      body: [
        makeNamespaceStatement("pkg", [
          {
            kind: NodeKind.ExportStatement,
            declaration: makeNamespaceStatement("tools", [
              {
                kind: NodeKind.ExportStatement,
                declaration: {
                  kind: NodeKind.FunctionStatement,
                  name: { kind: NodeKind.Identifier, name: "helper" }
                }
              }
            ])
          }
        ])
      ]
    } as Program;

    const result = await buildTargetPathMemberAccessCompletions(
      ast,
      session.analysis!,
      {
        objectPath: "pkg.tools",
        objectStartCharacter: 0,
        memberAccessStartCharacter: 9,
        prefix: ""
      },
      0,
      9,
      { text: "pkg.tools." },
      {},
      createClassResolverCache(),
      resolveExtensionMemberTypeName,
      buildMemberCompletionItemsForType
    );

    expect(result?.items.map((item) => item.label)).toEqual(["helper"]);
    expect(result?.shouldRecoverOnEmpty).toBe(false);
  });

  it("resolves typed receiver paths into member completions", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Box {
        value: int
      }
      fun demo(box: Box) {
        box.^^^
      }
    `);
    const session = createAnalysisSession(source);
    const target = parseMemberAccessTarget(source, line, character);

    const result = await buildTargetPathMemberAccessCompletions(
      session.ast!,
      session.analysis!,
      target!,
      line,
      character,
      {
        text: source,
        uri: pathToFileURL("/workspace/demo.vx").toString()
      },
      {},
      createClassResolverCache(),
      resolveExtensionMemberTypeName,
      buildMemberCompletionItemsForType
    );

    expect(result?.items.some((item) => item.label === "value")).toBe(true);
    expect(result?.shouldRecoverOnEmpty).toBe(true);
  });
});
