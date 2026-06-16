import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "../test/expect";
import { ensureDomProgram, getDomDeclarationFilePath } from "./domDeclarations";

function readBundledDomRuntime(): Promise<string> {
  return readFile(join(process.cwd(), "compiler", "runtime", "dom.d.ts"), "utf8");
}

describe("bundled dom runtime declarations", () => {
  it("loads and parses the bundled DOM declaration file", async () => {
    const program = await ensureDomProgram();

    expect(getDomDeclarationFilePath().endsWith("dom.d.ts")).toBe(true);
    expect(program.body.length > 0).toBe(true);
  });

  it("bundles DOM core, iterable, and async iterable declarations into one file", async () => {
    const source = await readBundledDomRuntime();

    expect(source).toContain("interface Document");
    expect(source).toContain("interface Window");
    expect(source).toContain("[Symbol.iterator](): ArrayIterator");
    expect(source).toContain("[Symbol.asyncIterator](): FileSystemDirectoryHandleAsyncIterator");
  });

  it("does not pull non-DOM host libraries into the bundle", async () => {
    const source = await readBundledDomRuntime();

    expect(source).not.toContain("declare var ActiveXObject");
    expect(source).not.toContain("interface DedicatedWorkerGlobalScope");
    expect(source).not.toContain("declare function importScripts");
  });

  it("keeps the DOM loader browser-safe", async () => {
    const [wrapperSource, sharedSource] = await Promise.all([
      readFile(join(process.cwd(), "compiler", "runtime", "domDeclarations.ts"), "utf8"),
      readFile(join(process.cwd(), "compiler", "runtime", "domDeclarations.shared.ts"), "utf8")
    ]);

    expect(sharedSource).not.toContain("node:fs");
    expect(sharedSource).not.toContain("node:path");
    expect(sharedSource).not.toContain("node:url");
    expect(wrapperSource).toContain('setRuntimeDeclarationsHost(nodeRuntimeDeclarationsHost)');
  });
});
