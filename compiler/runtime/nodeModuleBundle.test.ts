import { describe, expect, it, join, mkdir, mkdtemp, rm, tmpdir, writeFile } from "../test/expect";
import { bundleNodeModuleGraph } from "../../cli/nodeModuleBundle";

async function withTempProject(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vexa-node-module-bundle-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
  return run(dir).finally(async () => {
    await rm(dir, { recursive: true, force: true });
  });
}

describe("bundleNodeModuleGraph", () => {
  it("lowers bundled .mjs imports to runtime requires inside wrapped factories", async () => {
    await withTempProject(
      {
        "entry.js": 'const hooks = require("pkg/hooks"); module.exports.value = hooks.value;\n',
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          exports: {
            "./hooks": {
              import: "./hooks.mjs"
            }
          }
        }),
        "node_modules/pkg/hooks.mjs": 'import { value as sharedValue } from "./shared.mjs"; export const value = sharedValue;\n',
        "node_modules/pkg/shared.mjs": "export const value = 7;\n"
      },
      async (dir) => {
        const result = await bundleNodeModuleGraph(
          'const hooks = require("pkg/hooks"); module.exports.value = hooks.value;\n',
          join(dir, "entry.js")
        );

        expect(result.code).not.toContain('import { value as sharedValue } from "./shared.mjs";');
        expect(result.code).toContain('const { value: sharedValue } = require("./shared.mjs");');
      }
    );
  });

  it("parses and emits bundled TypeScript modules with the built-in emitter", async () => {
    await withTempProject(
      {
        "entry.ts": 'import { value } from "pkg/hooks"; export const doubled: number = value * 2;\n',
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          exports: {
            "./hooks": {
              import: "./hooks.ts"
            }
          }
        }),
        "node_modules/pkg/hooks.ts": "export const value: number = 7;\n"
      },
      async (dir) => {
        const result = await bundleNodeModuleGraph(
          'import { value } from "pkg/hooks"; export const doubled: number = value * 2;\n',
          join(dir, "entry.ts")
        );

        expect(result.code).toContain('const { value } = require("pkg/hooks");');
        expect(result.code).toContain("const doubled = value * 2;");
        expect(result.code).not.toContain(": number");
      }
    );
  });

  it("supports minified ESM default imports from bundled JavaScript modules", async () => {
    await withTempProject(
      {
        "entry.js": 'import render from "pkg/render"; export const value = render();\n',
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          exports: {
            "./render": {
              import: "./render.mjs"
            }
          }
        }),
        "node_modules/pkg/render.mjs": 'const impl=()=>7;export{impl as default};\n'
      },
      async (dir) => {
        const result = await bundleNodeModuleGraph(
          'import render from "pkg/render"; export const value = render();\n',
          join(dir, "entry.js")
        );

        expect(result.code).toContain('const __vexa_import_0 = require("pkg/render");');
        expect(result.code).toContain("const render = __vexa_import_0 && __vexa_import_0.__esModule ? __vexa_import_0.default : __vexa_import_0;");
        expect(result.code).toContain("exports.default = impl;");
        expect(result.code).toContain("exports.__esModule = true;");
      }
    );
  });

  it("parses JavaScript ESM default function exports through the shared emitter path before falling back", async () => {
    await withTempProject(
      {
        "entry.js": 'import render from "pkg/render"; export const value = render();\n',
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          exports: {
            "./render": {
              import: "./render.js"
            }
          }
        }),
        "node_modules/pkg/render.js": 'export default function render() {\n  return 7;\n}\n'
      },
      async (dir) => {
        const result = await bundleNodeModuleGraph(
          'import render from "pkg/render"; export const value = render();\n',
          join(dir, "entry.js")
        );

        expect(result.code).toContain("function render() {");
        expect(result.code).toContain("exports.default = render;");
        expect(result.code).toContain("exports.__esModule = true;");
      }
    );
  });

  it("supports mixed default and named imports from bundled JavaScript ESM modules", async () => {
    await withTempProject(
      {
        "entry.js": 'import render, { version as pkgVersion } from "pkg/render"; export const value = render() + pkgVersion;\n',
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          exports: {
            "./render": {
              import: "./render.js"
            }
          }
        }),
        "node_modules/pkg/render.js": 'export const version = 3;\nexport default function render() {\n  return 7;\n}\n'
      },
      async (dir) => {
        const result = await bundleNodeModuleGraph(
          'import render, { version as pkgVersion } from "pkg/render"; export const value = render() + pkgVersion;\n',
          join(dir, "entry.js")
        );

        expect(result.code).toContain('const __vexa_import_0 = require("pkg/render");');
        expect(result.code).toContain("const render = __vexa_import_0 && __vexa_import_0.__esModule ? __vexa_import_0.default : __vexa_import_0;");
        expect(result.code).toContain("const { version: pkgVersion } = __vexa_import_0;");
        expect(result.code).toContain("exports.version = version;");
        expect(result.code).toContain("exports.default = render;");
      }
    );
  });

  it("supports bundled JavaScript ESM re-exports through the shared emitter path", async () => {
    await withTempProject(
      {
        "entry.js": 'import render, { version } from "pkg/render"; export const value = render() + version;\n',
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          exports: {
            "./render": {
              import: "./render.js"
            }
          }
        }),
        "node_modules/pkg/render.js": 'export { version } from "./shared.js";\nexport { default } from "./shared.js";\n',
        "node_modules/pkg/shared.js": 'export const version = 4;\nexport default function render() {\n  return 7;\n}\n'
      },
      async (dir) => {
        const result = await bundleNodeModuleGraph(
          'import render, { version } from "pkg/render"; export const value = render() + version;\n',
          join(dir, "entry.js")
        );

        expect(result.code).toContain('const __vexa_export_0 = require("./shared.js");');
        expect(result.code).toContain("exports.version = __vexa_export_0.version;");
        expect(result.code).toContain("exports.default = __vexa_export_1.default;");
        expect(result.code).toContain("exports.__esModule = true;");
      }
    );
  });
});
