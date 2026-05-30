import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureLspTransportArg, runCli } from "./cli";

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
    const tokens = JSON.parse(String(logSpy.mock.calls[0][0])) as Array<{ type: string; value: string }>;
    expect(tokens.map(({ type, value }) => ({ type, value }))).toEqual([
      { type: "identifier", value: "a" },
      { type: "symbol", value: "+=" },
      { type: "number", value: "1" },
      { type: "eof", value: "<eof>" }
    ]);
  });

  it("ast command prints parsed AST as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "ast.my");
    await writeFile(input, "let myvar = 1 + 2;", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "ast", input]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
      kind: "Program",
      body: [
        {
          kind: "VarStatement",
          declarationKind: "let",
          name: { kind: "Identifier", name: "myvar" },
          initializer: {
            kind: "BinaryExpression",
            operator: "+",
            left: { kind: "IntLiteral", value: 1 },
            right: { kind: "IntLiteral", value: 2 }
          }
        }
      ]
    });
  });

  it("format command prints formatted source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "format.my");
    await writeFile(input, "let a=1\na+=2", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "format", input]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toBe("let a = 1;\na += 2;");
  });

  it("format command writes formatted source with --write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-cli-"));
    const input = join(dir, "format-write.my");
    await writeFile(input, "let a=1\na+=2", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "mylang", "format", input, "--write"]);

    expect(await readFile(input, "utf8")).toBe("let a = 1;\na += 2;\n");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain("Formatted:");
  });

  it("adds --stdio when starting language server without transport arg", () => {
    expect(ensureLspTransportArg(["node", "mylang", "--lsp"])).toEqual([
      "node",
      "mylang",
      "--lsp",
      "--stdio"
    ]);
  });

  it("keeps existing language server transport arg", () => {
    expect(ensureLspTransportArg(["node", "mylang", "--lsp", "--stdio"])).toEqual([
      "node",
      "mylang",
      "--lsp",
      "--stdio"
    ]);
    expect(ensureLspTransportArg(["node", "mylang", "--lsp", "--node-ipc"])).toEqual([
      "node",
      "mylang",
      "--lsp",
      "--node-ipc"
    ]);
    expect(ensureLspTransportArg(["node", "mylang", "--lsp", "--socket=6010"])).toEqual([
      "node",
      "mylang",
      "--lsp",
      "--socket=6010"
    ]);
  });
});
