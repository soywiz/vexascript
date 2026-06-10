import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./test/expect";
import { loadProject } from "./project";

describe("project configuration", () => {
  it("loads dependencies from package.json and JSX factories from tsconfig.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { preact: "10.29.2" } }), "utf8");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { jsxFactory: "h", jsxFragmentFactory: "Fragment" } }), "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toEqual({
      projectDir: dir,
      dependencies: { preact: "10.29.2" },
      libs: [],
      jsxFactory: "h",
      jsxFragmentFactory: "Fragment"
    });
  });

  it("loads compilerOptions.lib entries from tsconfig.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toEqual({
      projectDir: dir,
      dependencies: {},
      libs: ["es2025", "dom"]
    });
  });

  it("does not load legacy vexa.toml configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "vexa.toml"), "[jsx]\nfactory = \"h\"\n", "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toBe(null);
  });
});
