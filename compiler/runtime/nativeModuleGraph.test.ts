import { describe, expect, it, join, mkdtemp, rm, tmpdir, writeFile } from "../test/expect";
import { compileNativeModuleGraph } from "./nativeModuleGraph";

describe("native module graph", () => {
  it("maps node realpath imports to the native filesystem adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vexa-native-realpath-"));
    const entryPath = join(directory, "main.ts");
    await writeFile(
      entryPath,
      [
        'import { realpath } from "node:fs/promises";',
        "export async function canonicalPath(path: string): Promise<string> {",
        "  return await realpath(path);",
        "}",
      ].join("\n"),
      "utf8"
    );

    try {
      const result = await compileNativeModuleGraph(entryPath, "optimized", {
        importMappings: {
          "node:fs/promises": join(process.cwd(), "native", "modules", "nodeFsPromises.ts"),
        },
        typeCheck: false,
      });

      expect(result.errors).toEqual([]);
      expect(result.files?.map((file) => file.code).join("\n") ?? result.code)
        .toContain("vexa::nativeRealPath");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
