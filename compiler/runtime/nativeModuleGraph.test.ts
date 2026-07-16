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
      expect(result.code).toContain("vexa::Value format(");
      expect(result.code).toContain("vexa::Value describe(");
      expect(result.code).toContain("vexa::console.log(describe(runtime, 4))");
      expect(result.code).not.toContain("ImportStatement");
      expect(result.watchedFiles.length).toBe(3);
    });
  });

  it("rejects import aliases until module-local native symbol namespaces exist", async () => {
    await withTempProject({
      "value.vx": `export fun value(): int { return 1 }`,
      "main.vx": `import { value as renamed } from "./value.vx"
console.log(renamed())`,
    }, async (dir) => {
      const result = await compileNativeModuleGraph(join(dir, "main.vx"), "optimized");

      expect(result.errors[0]).toContain("Native C++ modules do not support import aliases yet");
    });
  });
});
