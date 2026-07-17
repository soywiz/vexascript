import { describe, expect, it, join, mkdtemp, rm, tmpdir, writeFile } from "../test/expect";
import { fileExists, isDirectory } from "./fs";
import { runCommand, runCommandCapture } from "../../cli/io";

describe("io utilities", () => {
  it("reports whether a file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-io-"));
    const filePath = join(dir, "fixture.txt");

    try {
      expect(await fileExists(filePath)).toBe(false);

      await writeFile(filePath, "hello", "utf8");

      expect(await fileExists(filePath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports whether a path is a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-io-"));
    const filePath = join(dir, "fixture.txt");

    try {
      await writeFile(filePath, "hello", "utf8");

      expect(await isDirectory(dir)).toBe(true);
      expect(await isDirectory(filePath)).toBe(false);
      expect(await isDirectory(join(dir, "missing"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs a command asynchronously and rejects on failure", async () => {
    await runCommand(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });

    await expect(
      runCommand(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" })
    ).rejects.toThrow(/exited with code 7/);
  });

  it("captures command output and exit status asynchronously", async () => {
    const result = await runCommandCapture(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
    ]);

    expect(result).toEqual({ code: 3, stdout: "out", stderr: "err" });
  });
});
