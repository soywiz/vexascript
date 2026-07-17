import { describe, expect, it, join, mkdir, mkdtemp, rm, tmpdir, writeFile } from "../test/expect";
import { compileNativeModuleGraph } from "./nativeModuleGraph";

async function withTempProject(
  files: Record<string, string>,
  run: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vexa-native-module-graph-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
  await run(dir).finally(async () => rm(dir, { recursive: true, force: true }));
}

describe("native C++ module graph", () => {
  it("emits transitive local modules once in dependency order", async () => {
    await withTempProject({
      "format.vx": `export fun format(value: int): string { return ` + "`value:${value}`" + ` }`,
      "counter.vx": `import { format } from "./format.vx"
export fun describe(value: int): string { return format(value + 1) }`,
      "main.vx": `import { describe } from "./counter.vx"
console.log(describe(4))`,
    }, async (dir) => {
      const result = await compileNativeModuleGraph(join(dir, "main.vx"), "optimized");

      expect(result.errors).toEqual([]);
      expect(result.code).toContain("vexa::Value __vexa_module_0_format(");
      expect(result.code).toContain("vexa::Value __vexa_module_1_describe(");
      expect(result.code).toContain(`#line 1 "${join(dir, "format.vx")}"`);
      expect(result.code).toContain(`#line 2 "${join(dir, "counter.vx")}"`);
      expect(result.code).toContain(`#line 2 "${join(dir, "main.vx")}"`);
      expect(result.code).toContain("vexa::console.log(__vexa_module_1_describe(runtime, 4))");
      expect(result.code).not.toContain("ImportStatement");
      expect(result.watchedFiles.length).toBe(3);
    });
  });

  it("supports aliased named imports", async () => {
    await withTempProject({
      "value.vx": `export fun value(): int { return 1 }`,
      "main.vx": `import { value as renamed } from "./value.vx"
console.log(renamed())`,
    }, async (dir) => {
      const result = await compileNativeModuleGraph(join(dir, "main.vx"), "optimized");

      expect(result.errors).toEqual([]);
      expect(result.code).toContain("vexa::console.log(__vexa_module_");
      expect(result.code).not.toContain("renamed(runtime)");
    });
  });

  it("isolates private top-level names from different modules", async () => {
    await withTempProject({
      "first.vx": `fun helper(): int => 1
export fun first(): int => helper()`,
      "second.vx": `fun helper(): int => 2
export fun second(): int => helper()`,
      "main.vx": `import { first } from "./first.vx"
import { second } from "./second.vx"
console.log(first(), second())`,
    }, async (dir) => {
      const result = await compileNativeModuleGraph(join(dir, "main.vx"), "optimized");

      expect(result.errors).toEqual([]);
      expect(result.code.match(/std::int32_t __vexa_module_\d+_helper/g)?.length).toBe(4);
    });
  });

  it("supports default and namespace imports", async () => {
    await withTempProject({
      "values.vx": `fun value(): int => 7
export default value
export { value }`,
      "main.vx": `import selected from "./values.vx"
import * as values from "./values.vx"
console.log(selected(), values.value())`,
    }, async (dir) => {
      const result = await compileNativeModuleGraph(join(dir, "main.vx"), "optimized");

      expect(result.errors).toEqual([]);
      expect(result.code).not.toContain("selected(runtime)");
      expect(result.code).not.toContain("values.value");
    });
  });

  it("compiles package specifiers mapped to native source", async () => {
    await withTempProject({
      "vendor/math.vx": "export fun double(value: int): int => value * 2",
      "main.vx": `import { double } from "native-math"
console.log(double(6))`,
    }, async (dir) => {
      const result = await compileNativeModuleGraph(join(dir, "main.vx"), "optimized", {
        importMappings: { "native-math": join(dir, "vendor", "math.vx") },
      });

      expect(result.errors).toEqual([]);
      expect(result.code).toContain("__vexa_module_0_double(runtime, 6)");
    });
  });

  it("diagnoses packages without native source mappings", async () => {
    await withTempProject({
      "main.vx": `import { render } from "javascript-only-package"
console.log(render())`,
    }, async (dir) => {
      const result = await compileNativeModuleGraph(join(dir, "main.vx"), "optimized");

      expect(result.errors[0]).toContain("has no native VexaScript/TypeScript source mapping");
      expect(result.errors[0]).toContain("javascript-only-package");
    });
  });

  it("supports aliased re-exports and cross-module generic specializations", async () => {
    await withTempProject({
      "generic.vx": `export fun identity<T>(value: T): T => value`,
      "facade.vx": `export { identity as select } from "./generic.vx"`,
      "main.vx": `import { select as choose } from "./facade.vx"
console.log(choose(3), choose("three"))`,
    }, async (dir) => {
      const result = await compileNativeModuleGraph(join(dir, "main.vx"), "optimized");

      expect(result.errors).toEqual([]);
      expect(result.code).toContain("template <typename T>\nT __vexa_module_0_identity");
      expect(result.code).toContain("__vexa_module_0_identity(runtime, 3)");
      expect(result.code).toContain('__vexa_module_0_identity(runtime, runtime.string("three"))');
    });
  });

  it("resolves imported generic extension properties without duplicating member semantics", async () => {
    await withTempProject({
      "extensions.vx": `val <T> Array<T>.doubledLength: number => length * 2`,
      "main.vx": `import { doubledLength } from "./extensions.vx"
console.log([1, 2, 3].doubledLength, ["x"].doubledLength)`,
    }, async (dir) => {
      const result = await compileNativeModuleGraph(join(dir, "main.vx"), "optimized");

      expect(result.errors).toEqual([]);
      expect(result.code).toContain("template <typename T>\ndouble __vexa_extension_property_Array_doubledLength");
      expect(result.code.match(/__vexa_extension_property_Array_doubledLength\(runtime,/g)?.length).toBe(2);
    });
  });
});
