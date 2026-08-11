import { describe, expect, it } from "../test/expect";
import { nodeRuntimeDeclarationsHost } from "./nodeDeclarationHost";

describe("node runtime declaration host", () => {
  it("loads bundled declarations independently of the active VFS", async () => {
    const declaration = await nodeRuntimeDeclarationsHost.loadDomDeclarations() as {
      filePath: string;
      source: string;
    };

    expect(declaration.filePath.endsWith("dom.d.ts")).toBe(true);
    expect(declaration.source).toContain("interface HTMLElement");
  });
});
