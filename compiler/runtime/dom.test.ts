import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "../test/expect";

function readBundledDomRuntime(): string {
  return readFileSync(join(process.cwd(), "compiler", "runtime", "dom.d.ts"), "utf8");
}

describe("bundled dom runtime declarations", () => {
  it("bundles DOM core, iterable, and async iterable declarations into one file", () => {
    const source = readBundledDomRuntime();

    expect(source).toContain("interface Document");
    expect(source).toContain("interface Window");
    expect(source).toContain("[Symbol.iterator](): ArrayIterator");
    expect(source).toContain("[Symbol.asyncIterator](): FileSystemDirectoryHandleAsyncIterator");
  });

  it("does not pull non-DOM host libraries into the bundle", () => {
    const source = readBundledDomRuntime();

    expect(source).not.toContain("declare var ActiveXObject");
    expect(source).not.toContain("interface DedicatedWorkerGlobalScope");
    expect(source).not.toContain("declare function importScripts");
  });
});
