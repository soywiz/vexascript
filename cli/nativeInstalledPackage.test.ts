import {
  describe,
  expect,
  it,
  join,
  mkdir,
  mkdtemp,
  rm,
  tmpdir,
  writeFile,
} from "../compiler/test/expect";
import { symlink } from "node:fs/promises";
import { runCommand, runCommandCapture } from "./io";

describe("installed native package", () => {
  it("builds and runs an executable outside the repository", async () => {
    const repositoryRoot = process.cwd();
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-installed-package-"));
    const consumerRoot = join(outputRoot, "consumer");
    try {
      await mkdir(consumerRoot, { recursive: true });
      const packed = await runCommandCapture("pnpm", ["pack", "--pack-destination", outputRoot], {
        cwd: repositoryRoot,
      });
      expect(packed.code).toBe(0);
      const archiveName = packed.stdout.trim().split("\n").at(-1)!;
      const archivePath = archiveName.startsWith("/") ? archiveName : join(repositoryRoot, archiveName);

      const packageRoot = join(consumerRoot, "node_modules", "vexascript");
      await mkdir(packageRoot, { recursive: true });
      await runCommand("tar", ["-xzf", archivePath, "--strip-components", "1", "-C", packageRoot]);
      // Dependency installation is already covered by the repository install.
      // Link it here so this test remains network-free while every VexaScript
      // source/native asset still comes from the packed tarball outside the checkout.
      await symlink(join(repositoryRoot, "node_modules"), join(packageRoot, "node_modules"), "dir");

      const sourcePath = join(consumerRoot, "main.vx");
      const executablePath = join(consumerRoot, "native-app");
      await writeFile(sourcePath, `console.log("installed", [1, 2, 3].map { it * 2 })\n`, "utf8");
      await runCommand(process.execPath, [join(packageRoot, "dist", "vexa.js"),
        "executable",
        sourcePath,
        "--out",
        executablePath,
      ], { cwd: consumerRoot });
      const executed = await runCommandCapture(executablePath, [], { cwd: consumerRoot });
      expect(executed.code).toBe(0);
      expect(executed.stderr).toBe("");
      expect(executed.stdout).toBe("installed [2, 4, 6]\n");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
