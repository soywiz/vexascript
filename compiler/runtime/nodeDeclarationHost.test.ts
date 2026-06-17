import { describe, expect, it } from "../test/expect";
import { globalVfs } from "../vfs";
import { nodeRuntimeDeclarationsHost } from "./nodeDeclarationHost";

describe("node runtime declaration host", () => {
  it("loads bundled declarations without requiring a configured VFS", async () => {
    const previousVfs = globalVfs.ref;

    delete (globalVfs as { ref?: typeof previousVfs }).ref;

    try {
      const declaration = await nodeRuntimeDeclarationsHost.loadEcmaScriptDeclarations() as {
        filePath: string;
        source: string;
        mtimeMs?: number;
      };

      expect(declaration.filePath.endsWith("es2025.d.ts")).toBe(true);
      expect(declaration.source).toContain("interface Array<T>");
      expect(typeof declaration.mtimeMs).toBe("number");
    } finally {
      globalVfs.ref = previousVfs;
    }
  });
});
