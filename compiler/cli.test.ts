import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli";

describe("CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("build command writes transpiled output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "input.my");
    const output = join(dir, "output.js");
    await writeFile(input, "let value = 1 + 2", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "build", input, "--out", output]);

    expect(await readFile(output, "utf8")).toBe("let value = 1 + 2;");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain("Compiled:");
  });

  it("tokens command prints token list as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "tokens.my");
    await writeFile(input, "a += 1", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "tokens", input]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual([
      { type: "identifier", value: "a" },
      { type: "symbol", value: "+=" },
      { type: "number", value: "1" }
    ]);
  });

  it("ast command prints parsed AST as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "ast.my");
    await writeFile(input, "a + 1", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "ast", input]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
      kind: "BinaryExpression",
      operator: "+",
      left: { kind: "Identifier", name: "a" },
      right: { kind: "IntLiteral", value: 1 }
    });
  });
});
