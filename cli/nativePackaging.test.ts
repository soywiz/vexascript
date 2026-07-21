import { describe, expect, it, join, readFile } from "../compiler/test/expect";
import { runCommandCapture } from "./io";

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

  it("guards Clang-only Oilpan warning probes before GCC parses them", async () => {
    const archive = join(process.cwd(), "native/oilpan-standalone-main.zip");
    const macros = await runCommandCapture("unzip", [
      "-p",
      archive,
      "oilpan-standalone-main/gc/src/base/macros.h",
    ]);

    expect(macros.code).toBe(0);
    expect(macros.stdout).not.toContain("defined(__has_warning) &&");
    expect(macros.stdout).toContain(
      "#if defined(__clang__) && defined(__has_warning)\n#if __has_warning"
    );
  });
});
