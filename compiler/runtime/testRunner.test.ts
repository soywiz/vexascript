import { describe, expect, it, join, mkdir, mkdtemp, tmpdir, writeFile } from "../test/expect";
import { discoverVexaScriptTestFiles, prependTestTypeDeclarations } from "../../cli/testRunner";
import { transpile } from "./transpile";

describe("VexaScript test runner", () => {
  it("discovers sorted .test.vx files while skipping generated dependency directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-test-runner-"));
    const alpha = join(dir, "alpha.test.vx");
    const betaDir = join(dir, "nested");
    const beta = join(betaDir, "beta.test.vx");
    const ignoredDir = join(dir, "node_modules");
    const ignored = join(ignoredDir, "ignored.test.vx");
    await mkdir(betaDir);
    await mkdir(ignoredDir);
    await writeFile(alpha, "", "utf8");
    await writeFile(join(dir, "regular.vx"), "", "utf8");
    await writeFile(beta, "", "utf8");
    await writeFile(ignored, "", "utf8");

    expect(await discoverVexaScriptTestFiles(dir)).toEqual([alpha, beta]);
  });

  it("embeds Node test typings in each generated test module", () => {
    const source = prependTestTypeDeclarations("test(\"arithmetic\") { assert(1 + 1 == 2) }");
    expect(source).toContain("interface VexaTestContext");
    expect(source).toContain("declare fun test(name: string");
    expect(source).toContain("declare fun assert(condition: boolean");
    expect(source).toContain('test("arithmetic")');
  });

  it("type-checks named tests and rejects invalid assert conditions", () => {
    const valid = transpile(prependTestTypeDeclarations(`test("arithmetic") {
  assert(1 + 1 == 2)
}`));
    expect(valid.errors).toEqual([]);

    const invalid = transpile(prependTestTypeDeclarations(`test("invalid") {
  assert("not a boolean")
}`));
    expect(invalid.errors.some((error) => error.includes("expected to be 'boolean'") || error.includes("expected 'boolean'"))).toBe(true);
  });
});
