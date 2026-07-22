import { describe, expect, it, join, mkdir, mkdtemp, rm, tmpdir, writeFile } from "../test/expect";
import { compileNativeModuleGraph } from "./nativeModuleGraph";

describe("native module graph profiling", () => {
  it("preserves TypeScript semantic rules while checking a native module graph", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vexa-native-module-typescript-semantics-"));
    try {
      await writeFile(
        join(directory, "main.ts"),
        [
          "class Parent { value(offset = 0): number { return 1 + offset; } }",
          "class Child extends Parent { value(offset = 0): number { return 2 + offset; } }",
          "console.log(new Child().value());",
        ].join("\n"),
        "utf8"
      );

      const result = await compileNativeModuleGraph(join(directory, "main.ts"), "optimized");

      expect(result.errors).toEqual([]);
      expect(result.code.length > 0).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it("collects compiler flags from native bindings in referenced modules", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vexa-native-module-flags-"));
    try {
      await writeFile(
        join(directory, "binding.vx"),
        [
          '@CppFlags("-I/native/include")',
          '@CppFlags("-L/native/lib")',
          '@CppFlags("-lnative")',
          '@CppBody("return native_value();")',
          "export declare fun nativeValue(): int",
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        join(directory, "main.vx"),
        'import { nativeValue } from "./binding.vx"\nconsole.log(nativeValue())',
        "utf8"
      );

      const result = await compileNativeModuleGraph(join(directory, "main.vx"), "optimized");

      expect(result.errors).toEqual([]);
      expect(result.nativeCompilerFlags).toEqual(["-I/native/include", "-L/native/lib", "-lnative"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
