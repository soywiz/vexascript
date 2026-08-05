import {
  describe,
  expect,
  it,
  join,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  tmpdir,
  writeFile,
} from "../../compiler/test/expect";
import { runCli } from "../../cli/cli";
import { runCommandCapture } from "../../cli/io";

describe("native module executable smoke", () => {
  it("links shared interface and generic class definitions across modules", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vexa-native-shared-definitions-smoke-"));
    const buildRoot = join(projectRoot, "build");
    const executablePath = join(projectRoot, "app");
    await writeFile(join(projectRoot, "model.ts"), `export interface Named { name: string }
export class Box<T> {
  constructor(public value: T) {}
  get(): T { return this.value; }
}
export function nameOf(value: Named): string { return value.name; }`, "utf8");
    await writeFile(join(projectRoot, "main.ts"), `import { Box, nameOf, type Named } from "./model";
const named: Named = { name: "shared" };
console.log(new Box<string>(nameOf(named)).get());`, "utf8");

    try {
      await runCli([
        "node",
        "vexa",
        "cpp",
        "link",
        join(projectRoot, "main.ts"),
        "--out",
        executablePath,
        "--build-dir",
        buildRoot,
      ]);
      const result = await runCommandCapture(executablePath, [], { cwd: projectRoot });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("shared");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("compiles aliases, default imports, namespaces, and colliding private names", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vexa-native-modules-smoke-"));
    const buildRoot = join(projectRoot, "build");
    const executablePath = join(projectRoot, "app");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "first.vx"), `fun helper(): int => 1
export fun first(): int => helper()
export default first`, "utf8");
    await writeFile(join(projectRoot, "second.vx"), `fun helper(): int => 2
export fun second(): int => helper()`, "utf8");
    await writeFile(join(projectRoot, "extensions.vx"), `val <T> Array<T>.doubledLength: number => length * 2
val int.tripled: int => this * 3`, "utf8");
    await writeFile(join(projectRoot, "main.vx"), `import selected from "./first.vx"
import { second as renamed } from "./second.vx"
import * as values from "./second.vx"
import { doubledLength, tripled } from "./extensions.vx"
fun shadowed(renamed: int): int => renamed
val shadowedLambda = [1].map { renamed: int -> renamed + 1 }
console.log(selected(), renamed(), values.second(), [1, 2, 3].doubledLength, 4.tripled, shadowed(9), shadowedLambda[0])`, "utf8");

    try {
      await runCli([
        "node",
        "vexa",
        "cpp",
        "link",
        join(projectRoot, "main.vx"),
        "--out",
        executablePath,
        "--build-dir",
        buildRoot,
      ]);
      const result = await runCommandCapture(executablePath, [], { cwd: projectRoot });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("1 2 2 6 12 9 2");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("builds configured project directories through cpp and cpp link", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vexa-native-project-smoke-"));
    await writeFile(join(projectRoot, "vexascript.json"), JSON.stringify({
      entrypoint: "src/main.vx",
      outDir: "native-dist",
    }), "utf8");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(join(projectRoot, "src", "value.vx"), "export fun value(): int => 12", "utf8");
    await writeFile(join(projectRoot, "src", "main.vx"), `import { value } from "./value.vx"
console.log(value())`, "utf8");

    try {
      await runCli(["node", "vexa", "cpp", projectRoot]);
      const cpp = await readFile(join(projectRoot, "native-dist", "module-0000.cpp"), "utf8");
      expect(cpp).toContain("__vexa_module_0_value");

      await runCli(["node", "vexa", "cpp", "link", projectRoot]);
      const executablePath = join(projectRoot, "native-dist", "main");
      const result = await runCommandCapture(executablePath, [], { cwd: projectRoot });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("12");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
