import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createAnalysisSession } from "./analysisSession";
import { collectCrossFileMemberDiagnostics } from "./memberDiagnostics";

describe("cross-file member diagnostics", () => {
  it("reports unknown class members for imported classes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-member-diag-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource = `class MyPoint(const x: number, const y: number) { }
`;
    const helloSource = `import { MyPoint } from "./world"
fun demo() {
  const point = new MyPoint()
  point.xx
  point.y
}
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = collectCrossFileMemberDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.message === "Property 'xx' does not exist on type 'MyPoint'"
      )
    ).toBe(true);
    expect(
      diagnostics.some(
        (diagnostic) => diagnostic.message.includes("Property 'y' does not exist")
      )
    ).toBe(false);
  });
});
