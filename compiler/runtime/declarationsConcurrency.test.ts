import { describe, expect, it } from "../test/expect";
import { patchRuntimeDeclarationsHost } from "./declarationHost";
import { ensureEcmaScriptRuntimeProgram } from "./ecmascriptDeclarations.shared";
import { ensureDomProgram } from "./domDeclarations.shared";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("runtime declaration caches", () => {
  it("retries the ECMAScript declaration load after a failure instead of caching the rejection", async () => {
    patchRuntimeDeclarationsHost({
      loadEcmaScriptDeclarations: async () => {
        throw new Error("transient load failure");
      }
    });

    await expect(ensureEcmaScriptRuntimeProgram()).rejects.toThrow("transient load failure");

    patchRuntimeDeclarationsHost({
      loadEcmaScriptDeclarations: async () => ({
        filePath: "es-test.d.ts",
        source: "declare var ecmaConcurrencyTestGlobal: number;\n"
      })
    });

    const program = await ensureEcmaScriptRuntimeProgram();
    expect(program.body.length).toBeGreaterThan(0);
  });

  it("shares a single in-flight ECMAScript declaration load across concurrent callers", async () => {
    // The previous test left the cache populated, so concurrent calls must
    // resolve to the very same parsed program without reloading.
    const [first, second] = await Promise.all([
      ensureEcmaScriptRuntimeProgram(),
      ensureEcmaScriptRuntimeProgram()
    ]);
    expect(first).toBe(second);
  });

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
