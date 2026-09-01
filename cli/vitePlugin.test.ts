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

  it("imports Preact factories for projects configured with jsxImportSource", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-vite-preact-"));
    temporaryDirectories.push(root);
    const sourceDir = join(root, "src");
    const sourcePath = join(sourceDir, "main.vx");
    await mkdir(sourceDir);
    await writeFile(
      join(root, "vexascript.json"),
      '{"compilerOptions":{"jsxImportSource":"preact"}}\n',
      "utf8"
    );

    const plugin = vexascript();
    const result = await plugin.transform!.call(
      transformContext(),
      "export const view = <div>Hello</div>",
      sourcePath
    );

    expect(result!.code).toContain(
      'import { h as __vexaJsxFactory, Fragment as __vexaJsxFragment } from "preact";'
    );
    expect(result!.code).toContain('__vexaJsxFactory("div", null, "Hello")');
  });

  it("lowers omitted new for constructors imported from package declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-vite-imported-constructor-"));
    temporaryDirectories.push(root);
    const sourceDir = join(root, "src");
    const packageDir = join(root, "node_modules", "geometry");
    const sourcePath = join(sourceDir, "main.vx");
    await Promise.all([
      mkdir(sourceDir, { recursive: true }),
      mkdir(packageDir, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(root, "package.json"), '{"type":"module"}\n', "utf8"),
      writeFile(
        join(packageDir, "package.json"),
        '{"name":"geometry","types":"index.d.ts"}\n',
        "utf8"
      ),
      writeFile(
        join(packageDir, "index.d.ts"),
        "export declare class Rectangle { constructor(x: number, y: number) }\n",
        "utf8"
      )
    ]);

    const plugin = vexascript();
    const result = await plugin.transform!.call(
      transformContext(),
      'import { Rectangle } from "geometry"\nexport const frame = Rectangle(1, 2)',
      sourcePath
    );

    expect(result!.code).toContain("new Rectangle(1, 2)");
  });

  it("lowers omitted new for constructors imported from local VexaScript modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-vite-local-constructor-"));
    temporaryDirectories.push(root);
    const sourceDir = join(root, "src");
    const sourcePath = join(sourceDir, "main.vx");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "Shape.vx"),
      "export class Shape { constructor(public size: number) {} }\n",
      "utf8"
    );

    const plugin = vexascript();
    const result = await plugin.transform!.call(
      transformContext(),
      'import { Shape } from "./Shape.vx"\nexport const shape = Shape(3)',
      sourcePath
    );

    expect(result!.code).toContain("new Shape(3)");
  });

  it("shares import analysis across concurrent transforms without cyclic waits", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-vite-concurrent-imports-"));
    temporaryDirectories.push(root);
    const sourceDir = join(root, "src");
    const alphaPath = join(sourceDir, "Alpha.vx");
    const betaPath = join(sourceDir, "Beta.vx");
    await mkdir(sourceDir, { recursive: true });
    const alphaSource = 'import { Beta } from "./Beta.vx"\nexport class Alpha {}\nexport const beta = Beta()';
    const betaSource = 'import { Alpha } from "./Alpha.vx"\nexport class Beta {}\nexport const alpha = Alpha()';
    await Promise.all([
      writeFile(alphaPath, alphaSource, "utf8"),
      writeFile(betaPath, betaSource, "utf8")
    ]);

    const plugin = vexascript();
    const [alpha, beta] = await Promise.all([
      plugin.transform!.call(transformContext(), alphaSource, alphaPath),
      plugin.transform!.call(transformContext(), betaSource, betaPath)
    ]);

    expect(alpha!.code).toContain("new Beta()");
    expect(beta!.code).toContain("new Alpha()");
  });

  it("lowers omitted new for constructors from configured DOM declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-vite-dom-constructor-"));
    temporaryDirectories.push(root);
    const sourceDir = join(root, "src");
    const sourcePath = join(sourceDir, "audio.vx");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(root, "vexascript.json"),
      '{"compilerOptions":{"lib":["dom"]}}\n',
      "utf8"
    );

    const plugin = vexascript();
    const result = await plugin.transform!.call(
      transformContext(),
      'export const sound = Audio("sound.mp3")',
      sourcePath
    );

    expect(result!.code).toContain('new Audio("sound.mp3")');
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

  it("reports integer literal divisions that truncate to zero as Vite warnings", async () => {
    const warnings: string[] = [];
    const plugin = vexascript();

    const result = await plugin.transform!.call(
      {
        ...transformContext(),
        warn(warning: string): void {
          warnings.push(warning);
        }
      },
      "const fixedStep = 1 \\ 60",
      "/src/constants.vx"
    );

    expect(result).not.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Integer literal division 1 \\ 60 truncates to 0");
  });
});
