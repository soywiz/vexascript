import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { createClassResolverCache, type ClassResolverOptions } from "./classResolver";
import { resolveTypeNameFromPath } from "./memberCompletionPathTypes";
import { resolveExtensionMemberTypeName } from "./memberCompletion";

const resolverOptions: ClassResolverOptions = {};

describe("memberCompletionPathTypes", () => {
  it("resolves literal root receiver types", async () => {
    const session = createAnalysisSession("1.toFixed");
    expect(await resolveTypeNameFromPath(
      session.ast!,
      session.analysis!,
      ["1"],
      0,
      0,
      resolverOptions,
      createClassResolverCache(),
      resolveExtensionMemberTypeName
    )).toBe("int");
  });

  it("resolves annotated bindings and chained class members", async () => {
    const session = createAnalysisSession(dedent`
      class Address {
        city: string = ""
      }
      class User {
        address: Address = new Address()
      }
      fun demo() {
        let user: User = new User()
        user.address.city
      }
    `);

    expect(await resolveTypeNameFromPath(
      session.ast!,
      session.analysis!,
      ["user"],
      7,
      4,
      resolverOptions,
      createClassResolverCache(),
      resolveExtensionMemberTypeName
    )).toBe("User");

    expect(await resolveTypeNameFromPath(
      session.ast!,
      session.analysis!,
      ["user", "address", "city"],
      7,
      4,
      resolverOptions,
      createClassResolverCache(),
      resolveExtensionMemberTypeName
    )).toBe("string");
  });

  it("falls back to initializer-based binding inference for the root segment", async () => {
    const session = createAnalysisSession(dedent`
      class Box {
        value: string = ""
      }
      fun demo() {
        let box = new Box()
        box.value
      }
    `);

    expect(await resolveTypeNameFromPath(
      session.ast!,
      session.analysis!,
      ["box", "value"],
      4,
      4,
      resolverOptions,
      createClassResolverCache(),
      resolveExtensionMemberTypeName
    )).toBe("string");
  });
});
