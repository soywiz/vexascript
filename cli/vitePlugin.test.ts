import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "../compiler/test/expect";
import { vexascript } from "./vitePlugin";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function transformContext(): { error(error: { message: string }): never } {
  return {
    error(error): never {
      throw new Error(error.message);
    }
  };
}

describe("Vite plugin", () => {
  it("transforms VexaScript modules to ESM and returns a Vite source map", async () => {
    const plugin = vexascript();
    const transform = plugin.transform;
    expect(transform).toBeDefined();

    const result = await transform!.call(
      transformContext(),
      'export fun greet(name: string) => `Hello ${name}`',
      "/project/src/greeting.vx"
    );

    expect(result).not.toBeNull();
    expect(result!.code).toContain("export function greet(name)");
    expect(result!.code).not.toContain("name: string");
    expect(result!.map.sources).toEqual(["greeting.vx"]);
    expect(result!.map.sourcesContent).toEqual(['export fun greet(name: string) => `Hello ${name}`']);
  });

  it("uses project JSX settings and explicit plugin overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-vite-"));
    temporaryDirectories.push(root);
    const sourceDir = join(root, "src");
    const sourcePath = join(sourceDir, "view.vx");
    await mkdir(sourceDir);
    await Promise.all([
      writeFile(join(root, "package.json"), '{"type":"module"}\n', "utf8"),
      writeFile(
        join(root, "vexascript.json"),
        '{"compilerOptions":{"jsxFactory":"configuredH","jsxFragmentFactory":"ConfiguredFragment"}}\n',
        "utf8"
      )
    ]);

    const configuredPlugin = vexascript();
    const configured = await configuredPlugin.transform!.call(
      transformContext(),
      "export val view = <div>Hello</div>",
      sourcePath
    );
    expect(configured!.code).toContain('configuredH("div"');

    const overriddenPlugin = vexascript({ jsxFactory: "customH" });
    const overridden = await overriddenPlugin.transform!.call(
      transformContext(),
      "export val view = <div>Hello</div>",
      sourcePath
    );
    expect(overridden!.code).toContain('customH("div"');
  });

  it("leaves non-module and asset requests to Vite", async () => {
    const plugin = vexascript();

    expect(await plugin.transform!.call(transformContext(), "let value = 1", "/src/main.ts")).toBeNull();
    expect(await plugin.transform!.call(transformContext(), "raw source", "/src/main.vx?raw")).toBeNull();
    expect(await plugin.transform!.call(transformContext(), "url source", "/src/main.vx?url")).toBeNull();
  });

  it("reports compiler diagnostics through the Vite transform context", async () => {
    const plugin = vexascript();

    await expect(
      plugin.transform!.call(transformContext(), "val broken =", "/src/broken.vx")
    ).rejects.toThrow("Expected a number literal");
  });
});
