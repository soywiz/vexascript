import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "../test/expect";

function readBundledRuntime(): string {
  return readFileSync(join(process.cwd(), "compiler", "runtime", "es2025.d.ts"), "utf8");
}

describe("bundled es2025 runtime declarations", () => {
  it("provides a parser-compatible TypeScript runtime surface", () => {
    const source = readBundledRuntime();

    expect(source).not.toContain('/// <reference lib="');
    expect(source).toContain("interface Array<T>");
    expect(source).toContain("interface PromiseConstructor");
    expect(source).toContain("try<T, U extends unknown[]>(callbackFn: (...args: U) => T | PromiseLike<T>, ...args: U): Promise<Awaited<T>>;");
  });

  it("stays focused on runtime globals rather than browser host libs", () => {
    const source = readBundledRuntime();

    expect(source).not.toContain("interface Document");
    expect(source).not.toContain("interface DedicatedWorkerGlobalScope");
    expect(source).not.toContain("declare var ActiveXObject");
  });
});
