import { describe, it } from "node:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "../test/expect";
import { loadCachedProgram, storeCachedProgram } from "./programCache";
import type { Program } from "compiler/ast/ast";

describe("runtime program cache", () => {
  it("stores and reloads programs by source path, salt, and mtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-program-cache-"));
    const sourceFilePath = join(dir, "runtime.d.ts");
    const mtimeMs = (await stat(dir)).mtimeMs;
    const program: Program = {
      kind: "Program",
      body: [
        {
          kind: "VarStatement",
          declarationKind: "const",
          name: { kind: "Identifier", name: "answer" },
          declarations: []
        } as unknown as Program["body"][number]
      ]
    };

    expect(await loadCachedProgram(sourceFilePath, mtimeMs, "salt-a")).toBe(null);
    await storeCachedProgram(sourceFilePath, mtimeMs, "salt-a", program);

    expect(await loadCachedProgram(sourceFilePath, mtimeMs, "salt-a")).toEqual(program);
    expect(await loadCachedProgram(sourceFilePath, mtimeMs + 1, "salt-a")).toBe(null);
    expect(await loadCachedProgram(sourceFilePath, mtimeMs, "salt-b")).toBe(null);
  });
});
