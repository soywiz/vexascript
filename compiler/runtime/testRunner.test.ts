import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { appendTestRuntimeSource, discoverMyLangTestFiles, runMyLangTests } from "./testRunner";

describe("MyLang test runner", () => {
  it("discovers sorted .test.my files while skipping generated dependency directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-test-runner-"));
    const alpha = join(dir, "alpha.test.my");
    const betaDir = join(dir, "nested");
    const beta = join(betaDir, "beta.test.my");
    const ignoredDir = join(dir, "node_modules");
    const ignored = join(ignoredDir, "ignored.test.my");
    await mkdir(betaDir);
    await mkdir(ignoredDir);
    await writeFile(alpha, "", "utf8");
    await writeFile(join(dir, "regular.my"), "", "utf8");
    await writeFile(beta, "", "utf8");
    await writeFile(ignored, "", "utf8");

    expect(await discoverMyLangTestFiles(dir)).toEqual([alpha, beta]);
  });

  it("runs unique discovered test files with inline helpers appended", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-test-runner-"));
    const testFile = join(dir, "sample.test.my");
    await writeFile(testFile, "test(() => { assert(true) })", "utf8");

    const calls: Array<{ source: string; filePath: string }> = [];
    const result = await runMyLangTests([dir, testFile], async (source, filePath) => {
      calls.push({ source, filePath });
    });

    expect(result.testFiles).toEqual([testFile]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.filePath).toBe(testFile);
    expect(calls[0]?.source).toBe(appendTestRuntimeSource("test(() => { assert(true) })"));
    expect(calls[0]?.source).toContain("fun assert(cond: boolean");
  });
});
