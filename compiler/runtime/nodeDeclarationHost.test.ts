import { describe, expect, it } from "../test/expect";
import { globalVfs } from "../vfs";
import { nodeRuntimeDeclarationsHost } from "./nodeDeclarationHost";

describe("node runtime declaration host", () => {
  it("loads bundled declarations without requiring a configured VFS", async () => {
    const previousVfs = globalVfs.ref;

    delete (globalVfs as { ref?: typeof previousVfs }).ref;

    try {
      const declaration = await nodeRuntimeDeclarationsHost.loadDomDeclarations() as {
        filePath: string;
        source: string;
      };

      expect(declaration.filePath.endsWith("dom.d.ts")).toBe(true);
      expect(declaration.source).toContain("interface HTMLElement");
    } finally {
      globalVfs.ref = previousVfs;
    }
  });
});
