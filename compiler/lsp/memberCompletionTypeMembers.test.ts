import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { createClassResolverCache } from "./classResolver";
import {
  buildNonClassMemberCompletionItems,
  resolveInterfaceCompletionMembers
} from "./memberCompletionTypeMembers";

describe("memberCompletionTypeMembers", () => {
  it("resolves interface completion members with field and method details", async () => {
    const session = createAnalysisSession(dedent`
      interface Point {
        x: int
        move(dx: int): Point
      }
    `);

    const resolved = await resolveInterfaceCompletionMembers(
      session.ast!,
      "Point",
      {},
      createClassResolverCache()
    );

    expect(resolved.hasInterfaceStatement).toBe(true);
    expect(resolved.interfaceMembers).toEqual([
      {
        name: "x",
        kind: 5,
        detail: "Interface property: int"
      },
      {
        name: "move",
        kind: 2,
        detail: "Interface method: (dx: int) => Point"
      }
    ]);
  });

  it("builds enum completion items through the non-class path", async () => {
    const session = createAnalysisSession(dedent`
      enum Demo {
        HELLO,
        WORLD
      }
    `);

    expect(await buildNonClassMemberCompletionItems(
      session.ast!,
      "Demo",
      "HE",
      {},
      {},
      createClassResolverCache()
    )).toEqual([
      {
        label: "HELLO",
        kind: 20,
        detail: "Enum member: Demo",
        sortText: "2-HELLO"
      }
    ]);
  });

  it("falls back to ambient interfaces, type aliases, and structural object types", async () => {
    const ambientSession = createAnalysisSession("");
    const ambientDeclarations = createAnalysisSession(dedent`
      declare interface FancyDoc {
        body: string
      }
    `).ast!.body;
    const ambientItems = await buildNonClassMemberCompletionItems(
      ambientSession.ast!,
      "FancyDoc",
      "",
      { ambientDeclarations },
      {},
      createClassResolverCache()
    );
    expect(ambientItems.map((item) => item.label)).toEqual(["body"]);

    const aliasSession = createAnalysisSession("type Box = { value: string }");
    const aliasItems = await buildNonClassMemberCompletionItems(
      aliasSession.ast!,
      "Box",
      "",
      {},
      {},
      createClassResolverCache()
    );
    expect(aliasItems.map((item) => item.label)).toEqual(["value"]);

    const structuralItems = await buildNonClassMemberCompletionItems(
      aliasSession.ast!,
      "{ count: int, reset: () => void }",
      "re",
      {},
      {},
      createClassResolverCache()
    );
    expect(structuralItems.map((item) => item.label)).toEqual(["reset"]);
  });
});
