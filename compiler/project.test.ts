import { describe, expect, it, join, mkdtemp, tmpdir, writeFile } from "./test/expect";
import { loadProject } from "./project";
import { resolveServeBundleInput } from "../cli/cliShared";

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
      types: [],
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
      libs: ["es2025", "dom"],
      types: []
    });
  });

  it("loads compilerOptions.types entries from tsconfig.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: ["node"] } }), "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toEqual({
      projectDir: dir,
      dependencies: {},
      libs: [],
      types: ["node"]
    });
  });

  it("loads bundle entrypoint from vexascript.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({ entrypoint: "html.vx" }), "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toEqual({
      projectDir: dir,
      dependencies: {},
      libs: [],
      types: [],
      bundleEntrypoint: join(dir, "html.vx")
    });
  });

  it("resolves serve bundle input from vexascript.json when --bundle is omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({ entrypoint: "html.vx" }), "utf8");

    expect(await resolveServeBundleInput(dir)).toBe(join(dir, "html.vx"));
  });

  it("does not load legacy vexa.toml configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "vexa.toml"), "[jsx]\nfactory = \"h\"\n", "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toBe(null);
  });
});
