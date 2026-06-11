import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./test/expect";

describe("vfs layering", () => {
  it("keeps compiler/vfs.ts free of Node-specific imports", async () => {
    const source = await readFile(join(process.cwd(), "compiler", "vfs.ts"), "utf8");

    expect(source.includes("node:")).toBe(false);
    expect(source.includes("LocalVfs")).toBe(false);
  });

  it("keeps the Node-backed VFS implementation in compiler/localVfs.ts", async () => {
    const source = await readFile(join(process.cwd(), "compiler", "localVfs.ts"), "utf8");

    expect(source.includes('from "node:fs/promises"')).toBe(true);
    expect(source.includes("export class LocalVfs")).toBe(true);
    expect(source.includes("export const localVfs")).toBe(true);
  });
});
