import { describe, expect, it, join, readFile } from "../compiler/test/expect";

describe("native package contents", () => {
  it("publishes every source artifact required by cpp and executable", async () => {
    const root = process.cwd();
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { files?: string[] };
    const required = [
      "native/runtime.cpp",
      "native/bigint.h",
      "native/oilpan-standalone-main.zip",
    ];
    for (const path of required) {
      expect(manifest.files).toContain(path);
      expect((await readFile(join(root, path))).byteLength).toBeTruthy();
    }
  });
});
