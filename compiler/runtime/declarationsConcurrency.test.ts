import { describe, expect, it } from "../test/expect";
import { DeclarationProgramCache } from "./declarationProgramCache";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("runtime declaration caches", () => {
  it("shares a single in-flight declaration load across concurrent callers", async () => {
    let loadCalls = 0;
    const gate = deferred();
    const cache = new DeclarationProgramCache(async () => {
      loadCalls += 1;
      await gate.promise;
      return {
        program: {} as never,
        nodes: new WeakSet<object>()
      };
    });

    const firstCall = cache.ensure();
    const secondCall = cache.ensure();
    gate.resolve();
    const [first, second] = await Promise.all([firstCall, secondCall]);

    expect(loadCalls).toBe(1);
    expect(first).toBe(second);
  });
});
