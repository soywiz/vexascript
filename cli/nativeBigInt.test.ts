import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "../compiler/test/expect";
import { runCommandCapture } from "./io";

describe("native bigint", () => {
  it("preserves signed quotient and remainder semantics for single-limb divisors", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-native-bigint-"));
    const sourcePath = join(root, "bigint.cpp");
    const executablePath = join(root, "bigint");
    try {
      await writeFile(sourcePath, [
        '#include "bigint.h"',
        "#include <iostream>",
        "int main() {",
        "  using vexa::BigInt;",
        '  const BigInt large("123456789012345678901234567890");',
        "  std::cout << large / BigInt(3) << '\\n';",
        "  std::cout << BigInt(-10) / BigInt(3) << ' ' << BigInt(-10) % BigInt(3) << '\\n';",
        "  std::cout << BigInt(10) / BigInt(-3) << ' ' << BigInt(10) % BigInt(-3) << '\\n';",
        '  std::cout << BigInt("16000000000000000000") / BigInt("4000000000") << \'\\n\';',
        '  std::cout << BigInt("100000000000000000000") / BigInt("10000000000") << \'\\n\';',
        "}",
      ].join("\n"), "utf8");

      const compilation = await runCommandCapture("g++", [
        "-std=c++20",
        "-O2",
        "-I",
        join(process.cwd(), "native"),
        sourcePath,
        "-o",
        executablePath,
      ]);
      expect(compilation.code, compilation.stderr).toBe(0);
      const execution = await runCommandCapture(executablePath, []);
      expect(execution.code, execution.stderr).toBe(0);
      expect(execution.stdout.trim().split("\n")).toEqual([
        "41152263004115226300411522630",
        "-3 -1",
        "-3 1",
        "4000000000",
        "10000000000",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
