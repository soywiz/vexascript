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
} from "../compiler/test/expect";
import { runCli } from "./cli";
import { runCommandCapture } from "./io";

describe("native module executable smoke", () => {
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
    await writeFile(join(projectRoot, "extensions.vx"), `val <T> Array<T>.doubledLength: number => length * 2`, "utf8");
    await writeFile(join(projectRoot, "main.vx"), `import selected from "./first.vx"
import { second as renamed } from "./second.vx"
import * as values from "./second.vx"
import { doubledLength } from "./extensions.vx"
fun shadowed(renamed: int): int => renamed
val shadowedLambda = [1].map { renamed: int -> renamed + 1 }
console.log(selected(), renamed(), values.second(), [1, 2, 3].doubledLength, shadowed(9), shadowedLambda[0])`, "utf8");

    try {
      await runCli([
        "node",
        "vexa",
        "executable",
        join(projectRoot, "main.vx"),
        "--out",
        executablePath,
        "--build-dir",
        buildRoot,
      ]);
      const result = await runCommandCapture(executablePath, [], { cwd: projectRoot });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("1 2 2 6 9 2");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("builds configured project directories through cpp and executable", async () => {
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
      const cpp = await readFile(join(projectRoot, "native-dist", "main.cpp"), "utf8");
      expect(cpp).toContain("__vexa_module_0_value");

      await runCli(["node", "vexa", "executable", projectRoot]);
      const executablePath = join(projectRoot, "native-dist", "main");
      const result = await runCommandCapture(executablePath, [], { cwd: projectRoot });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("12");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
