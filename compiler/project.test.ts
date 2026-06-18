import { describe, expect, it, join, mkdtemp, tmpdir, writeFile } from "./test/expect";
import { loadProject } from "./project";
import { resolveServeBundleInput } from "../cli/cliShared";

describe("project configuration", () => {
  it("loads dependencies from package.json and JSX factories from vexascript.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { preact: "10.29.2" } }), "utf8");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({
      compilerOptions: { jsxFactory: "h", jsxFragmentFactory: "Fragment" }
    }), "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toEqual({
      projectDir: dir,
      dependencies: { preact: "10.29.2" },
      libs: [],
      types: [],
      serveMappings: [],
      jsxFactory: "h",
      jsxFragmentFactory: "Fragment"
    });
  });

  it("loads compilerOptions.lib entries from vexascript.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toEqual({
      projectDir: dir,
      dependencies: {},
      libs: ["es2025", "dom"],
      types: [],
      serveMappings: []
    });
  });

  it("loads compilerOptions.types entries from vexascript.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({ compilerOptions: { types: ["node"] } }), "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toEqual({
      projectDir: dir,
      dependencies: {},
      libs: [],
      types: ["node"],
      serveMappings: []
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
      serveMappings: [],
      bundleEntrypoint: join(dir, "html.vx")
    });
  });

  it("loads object-form serve mappings from vexascript.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({
      serveMappings: {
        "node_modules/pixi.js/dist/pixi.js": "pixi.js",
        "./public/assets": "assets"
      }
    }), "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toEqual({
      projectDir: dir,
      dependencies: {},
      libs: [],
      types: [],
      serveMappings: [
        { from: join(dir, "node_modules/pixi.js/dist/pixi.js"), to: "pixi.js" },
        { from: join(dir, "public/assets"), to: "assets" }
      ]
    });
  });

  it("loads legacy array-form serve mappings from vexascript.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({
      serveMappings: [
        { from: "node_modules/pixi.js/dist/pixi.js", to: "pixi.js" },
        { from: "./public/assets", to: "assets" }
      ]
    }), "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toEqual({
      projectDir: dir,
      dependencies: {},
      libs: [],
      types: [],
      serveMappings: [
        { from: join(dir, "node_modules/pixi.js/dist/pixi.js"), to: "pixi.js" },
        { from: join(dir, "public/assets"), to: "assets" }
      ]
    });
  });

  it("falls back to tsconfig.json compiler options when vexascript.json omits them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({ entrypoint: "html.vx" }), "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toEqual({
      projectDir: dir,
      dependencies: {},
      libs: ["es2025", "dom"],
      types: [],
      serveMappings: [],
      bundleEntrypoint: join(dir, "html.vx")
    });
  });

  it("prefers vexascript.json compiler options over tsconfig.json when both exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        jsxFactory: "oldH",
        jsxFragmentFactory: "OldFragment",
        lib: ["es2025"],
        types: ["node"]
      }
    }), "utf8");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({
      compilerOptions: {
        jsxFactory: "h",
        jsxFragmentFactory: "Fragment",
        lib: ["es2025", "dom"],
        types: ["bun"]
      }
    }), "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toEqual({
      projectDir: dir,
      dependencies: {},
      libs: ["es2025", "dom"],
      types: ["bun"],
      serveMappings: [],
      jsxFactory: "h",
      jsxFragmentFactory: "Fragment"
    });
  });

  it("treats an explicit empty vexascript.json types array as overriding tsconfig.json types", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-project-"));
    const input = join(dir, "main.vx");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        lib: ["es2025"],
        types: ["node"]
      }
    }), "utf8");
    await writeFile(join(dir, "vexascript.json"), JSON.stringify({
      compilerOptions: {
        lib: ["es2025", "dom"],
        types: []
      }
    }), "utf8");
    await writeFile(input, "", "utf8");

    expect(await loadProject(input)).toEqual({
      projectDir: dir,
      dependencies: {},
      libs: ["es2025", "dom"],
      types: [],
      serveMappings: []
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
