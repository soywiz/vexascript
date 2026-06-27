import { describe, expect, it } from "../test/expect";
import { patchRuntimeDeclarationsHost } from "./declarationHost";
import { ensureDomProgram } from "./domDeclarations.shared";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("runtime declaration caches", () => {
  it("shares a single in-flight DOM declaration load across concurrent callers", async () => {
    let loadCalls = 0;
    const gate = deferred();
    patchRuntimeDeclarationsHost({
      loadDomDeclarations: async () => {
        loadCalls += 1;
        await gate.promise;
        return {
          filePath: "dom-test.d.ts",
          source: "declare var domConcurrencyTestGlobal: number;\n"
        };
      }
    });

    const firstCall = ensureDomProgram();
    const secondCall = ensureDomProgram();
    gate.resolve();
    const [first, second] = await Promise.all([firstCall, secondCall]);

    expect(loadCalls).toBe(1);
    expect(first).toBe(second);
  });
});
