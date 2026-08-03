import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "../../compiler/test/expect";
import { runCommandCapture } from "../../cli/io";

describe("native bigint", () => {
  it("preserves arithmetic semantics across optimized bigint paths", async () => {
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
        '  std::cout << BigInt("0x123456789abcdef0") << \'\\n\';',
        '  std::cout << BigInt("0o123456701234") << \'\\n\';',
        '  std::cout << BigInt("0b1010101010101010101010101010101") << \'\\n\';',
        '  std::cout << large * BigInt(33) << \'\\n\';',
        '  std::cout << large / BigInt("123456789012345") << \' \' << large % BigInt("123456789012345") << \'\\n\';',
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
        "1311768467463790320",
        "11219468956",
        "1431655765",
        "4074074037407407403740740740370",
        "1000000000000005 61617289506165",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
