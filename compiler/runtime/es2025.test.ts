import { describe, expect, it, join, readFile } from "../test/expect";
import { ensureVexaScriptRuntimeProgram } from "./ecmascriptDeclarations";

function readBundledRuntime(): Promise<string> {
  return readFile(join(process.cwd(), "compiler", "runtime", "es2025.d.ts"), "utf8");
}

describe("bundled es2025 runtime declarations", () => {
  it("provides a parser-compatible TypeScript runtime surface", async () => {
    const source = await readBundledRuntime();

    expect(source).not.toContain('/// <reference lib="');
    expect(source).toContain("interface Array<T>");
    expect(source).toContain("interface PromiseConstructor");
    expect(source).toContain("declare var Uint8Array: Uint8ArrayConstructor;");
    expect(source).toContain("try<T, U extends unknown[]>(callbackFn: (...args: U) => T | PromiseLike<T>, ...args: U): Promise<Awaited<T>>;");
  });

  it("stays focused on runtime globals rather than browser host libs", async () => {
    const source = await readBundledRuntime();

    expect(source).not.toContain("interface Document");
    expect(source).not.toContain("interface DedicatedWorkerGlobalScope");
    expect(source).not.toContain("declare var ActiveXObject");
  });

  it("keeps VexaScript-specific annotation declarations in the dedicated runtime file", async () => {
    const program = await ensureVexaScriptRuntimeProgram();
    const names = program.body
      .filter((statement) => statement.kind === "AnnotationStatement")
      .map((statement) => (statement as unknown as { name: { name: string } }).name.name);

    expect(names).toContain("JsName");
    expect(names).toContain("JsInline");
  });
});
