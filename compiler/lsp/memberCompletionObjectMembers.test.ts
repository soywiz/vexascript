import { NodeKind } from "compiler/ast/ast";
import { describe, expect, it } from "../test/expect";
import { CompletionItemKind } from "./completionModel";
import {
  parseObjectTypeTextMembers,
  parseTypeAliasObjectMembers,
  typeAliasSubstitutions
} from "./memberCompletionObjectMembers";
import type { TypeAliasStatement } from "compiler/ast/ast";

describe("memberCompletionObjectMembers", () => {
  it("parses structural object members and callable properties", () => {
    expect(parseObjectTypeTextMembers("{ size: int, map(value: int) => string, done?: () => boolean }")).toEqual([
      {
        name: "size",
        kind: CompletionItemKind.Field,
        detail: "Type alias property: int"
      },
      {
        name: "map",
        kind: CompletionItemKind.Method,
        detail: "Type alias method: (value: int) => string"
      },
      {
        name: "done",
        kind: CompletionItemKind.Method,
        detail: "Type alias method: () => boolean"
      }
    ]);
  });

  it("merges intersection members, removes readonly modifiers, and skips mapped keys", () => {
    expect(parseObjectTypeTextMembers(
      "{ [P in K]: unknown } & { readonly currentTarget: HTMLButtonElement }"
    )).toEqual([
      {
        name: "currentTarget",
        kind: CompletionItemKind.Field,
        detail: "Type alias property: HTMLButtonElement"
      }
    ]);
  });

  it("substitutes generic type parameters into aliased object members", () => {
    const typeAlias = {
      kind: NodeKind.TypeAliasStatement,
      name: { kind: NodeKind.Identifier, name: "Box" },
      typeParameters: [
        {
          kind: NodeKind.TypeParameter,
          name: { kind: NodeKind.Identifier, name: "T" }
        }
      ],
      targetType: {
        kind: NodeKind.Identifier,
        name: "{ value: T; map(transform: string) => T }"
      }
    } as TypeAliasStatement;

    expect(typeAliasSubstitutions(typeAlias, "Box<int>")).toEqual(new Map([["T", "int"]]));
    expect(parseTypeAliasObjectMembers(typeAlias, "Box<int>")).toEqual([
      {
        name: "value",
        kind: CompletionItemKind.Field,
        detail: "Type alias property: int"
      },
      {
        name: "map",
        kind: CompletionItemKind.Method,
        detail: "Type alias method: (transform: string) => int"
      }
    ]);
  });
});
