import { describe, expect, it, join, mkdir, mkdtemp, rm, tmpdir, writeFile } from "../test/expect";
import { compileNativeModuleGraph } from "./nativeModuleGraph";

describe("native module graph profiling", () => {
  it("reports browser-compatible phase timings through an optional callback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vexa-native-module-profile-"));
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "value.vx"), "export fun value(): int => 1", "utf8");
      await writeFile(
        join(directory, "main.vx"),
        `import { value } from "./value.vx"\nconsole.log(value())`,
        "utf8"
      );
      const events: Array<{ phase: string; elapsedMs: number; moduleCount: number }> = [];
      const result = await compileNativeModuleGraph(join(directory, "main.vx"), "optimized", {
        profile: (event) => events.push(event),
      });

      expect(result.errors).toEqual([]);
      expect(events.map((event) => event.phase)).toEqual([
        "load-and-parse",
        "module-isolation-resolution",
        "module-isolation-resolution",
        "module-isolation-analysis",
        "merged-binding",
        "merged-type-checking",
        "merged-analysis",
        "cpp-emission",
        "total",
      ]);
      expect(events.every((event) => event.elapsedMs >= 0 && event.moduleCount === 2)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps emitter inference without semantic validation for transpile-only native builds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vexa-native-module-transpile-only-"));
    try {
      await writeFile(join(directory, "main.vx"), "console.log('native')", "utf8");
      const phases: string[] = [];
      const result = await compileNativeModuleGraph(join(directory, "main.vx"), "optimized", {
        typeCheck: false,
        profile: (event) => phases.push(event.phase),
      });

      expect(result.errors).toEqual([]);
      expect(result.code.length > 0).toBe(true);
      expect(phases).toContain("merged-binding");
      expect(phases).toContain("merged-type-inference");
      expect(phases).not.toContain("merged-type-checking");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
