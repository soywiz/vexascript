import { describe, expect, it, join, readFile } from "./test/expect";
import { createUnconfiguredVfs } from "./vfs";

describe("vfs layering", () => {
  it("keeps compiler/vfs.ts free of Node-specific imports", async () => {
    const source = await readFile(join(process.cwd(), "compiler", "vfs.ts"), "utf8");

    expect(source.includes("node:")).toBe(false);
    expect(source.includes("LocalVfs")).toBe(false);
  });

  it("keeps the Node-backed VFS implementation in cli/localVfs.ts", async () => {
    const source = await readFile(join(process.cwd(), "cli", "localVfs.ts"), "utf8");

    expect(source.includes('from "node:fs/promises"')).toBe(true);
    expect(source.includes("export class LocalVfs")).toBe(true);
    expect(source.includes("export const localVfs")).toBe(true);
  });

  it("returns a placeholder VFS object when no global VFS has been configured", async () => {
    const unconfiguredVfs = createUnconfiguredVfs();

    expect(typeof unconfiguredVfs).toBe("object");
    await expect(unconfiguredVfs.readFile("/missing")).rejects.toThrow(
      "VFS has not been initialized. Call setVfs(...) before using compiler filesystem APIs."
    );
  });
});
