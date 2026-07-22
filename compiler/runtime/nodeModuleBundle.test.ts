import { describe, expect, it, join, mkdir, mkdtemp, rm, tmpdir, writeFile } from "../test/expect";
import {
  bundleNodeModuleGraph,
  collectCommonJsExports,
  createNodeModuleBundleIncrementalCache,
  detectStaticDynamicImports,
  detectStaticRequires,
  rewriteStaticDynamicImports,
  shouldPreserveCommonJsSource,
  transpileModuleSource
} from "../../cli/nodeModuleBundle";

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

describe("shouldPreserveCommonJsSource", () => {
  it("returns true for a .js file with module.exports", () => {
    expect(shouldPreserveCommonJsSource('module.exports = { foo: 1 };', "/lib/foo.js")).toBe(true);
  });

  it("returns true for a .cjs file with exports.x assignment", () => {
    expect(shouldPreserveCommonJsSource('exports.foo = 42;', "/lib/foo.cjs")).toBe(true);
  });

  it("returns true for a .js file with require() call", () => {
    expect(shouldPreserveCommonJsSource('const x = require("bar");', "/lib/foo.js")).toBe(true);
  });

  it("returns false when the file also has ESM export markers", () => {
    expect(shouldPreserveCommonJsSource('const x = require("bar");\nexport const y = x;', "/lib/foo.js")).toBe(false);
  });

  it("returns false for a .mjs file regardless of content", () => {
    expect(shouldPreserveCommonJsSource('module.exports = {};', "/lib/foo.mjs")).toBe(false);
  });

  it("returns false for a .ts file", () => {
    expect(shouldPreserveCommonJsSource('exports.foo = 1;', "/lib/foo.ts")).toBe(false);
  });

  it("returns false for a .js file with no CommonJS markers", () => {
    expect(shouldPreserveCommonJsSource('export const x = 1;', "/lib/foo.js")).toBe(false);
  });
});

describe("detectStaticRequires", () => {
  it("extracts single require specifier", () => {
    expect(detectStaticRequires('const x = require("foo");')).toEqual(["foo"]);
  });

  it("extracts multiple unique specifiers", () => {
    expect(detectStaticRequires('require("a");\nrequire("b");\nrequire("a");')).toEqual(["a", "b"]);
  });

  it("ignores require calls with non-string arguments", () => {
    expect(detectStaticRequires('require(name);')).toEqual([]);
  });

  it("accepts single-quoted string literals", () => {
    expect(detectStaticRequires("require('bar');")).toEqual(["bar"]);
  });

  it("returns empty array when no requires are present", () => {
    expect(detectStaticRequires('const x = 1;')).toEqual([]);
  });
});

describe("detectStaticDynamicImports", () => {
  it("extracts single dynamic import specifier", () => {
    expect(detectStaticDynamicImports('const x = import("foo");')).toEqual(["foo"]);
  });

  it("ignores non-literal dynamic imports", () => {
    expect(detectStaticDynamicImports("const x = import(name);")).toEqual([]);
  });
});

describe("rewriteStaticDynamicImports", () => {
  it("rewrites literal dynamic imports to the bundle helper", () => {
    expect(rewriteStaticDynamicImports('await import("./foo.mjs");')).toBe('await __vexaImport("./foo.mjs");');
  });

  it("does not rewrite import examples that appear inside string literals", () => {
    const source = [
      'const warning = "lazy: Expected the result of a dynamic import() call. Your code should look like: lazy(() => import(\'./MyComponent\'))";',
      'const mod = await import("./real.mjs");'
    ].join("\n");

    expect(rewriteStaticDynamicImports(source)).toBe([
      'const warning = "lazy: Expected the result of a dynamic import() call. Your code should look like: lazy(() => import(\'./MyComponent\'))";',
      'const mod = await __vexaImport("./real.mjs");'
    ].join("\n"));
  });
});

describe("collectCommonJsExports", () => {
  it("collects named exports from exports.x = assignments", () => {
    const names = collectCommonJsExports('exports.foo = 1;\nexports.bar = 2;');
    expect(names).toContain("foo");
    expect(names).toContain("bar");
  });

  it("collects default export from exports.default assignment", () => {
    expect(collectCommonJsExports('exports.default = fn;')).toContain("default");
  });

  it("collects default export from module.exports assignment", () => {
    expect(collectCommonJsExports('module.exports = fn;')).toContain("default");
  });

  it("excludes __esModule marker from export names", () => {
    expect(collectCommonJsExports('exports.__esModule = true;')).not.toContain("__esModule");
  });

  it("returns empty array when no exports are present", () => {
    expect(collectCommonJsExports('const x = 1;')).toEqual([]);
  });
});

describe("transpileModuleSource", () => {
  it("preserves CommonJS .js source unchanged and returns null exportNames", () => {
    const cjs = 'const x = require("foo");\nexports.value = x;';
    const result = transpileModuleSource(cjs, "/lib/foo.js");
    expect(result.code).toBe(cjs);
    expect(result.exportNames).toBeNull();
  });

  it("strips TypeScript type annotations through the emitter path", () => {
    const ts = 'export const value: number = 7;';
    const result = transpileModuleSource(ts, "/lib/foo.ts");
    expect(result.code).not.toContain(": number");
    expect(result.code).toContain("exports.value = value");
    expect(result.exportNames).toContain("value");
  });

  it("converts JavaScript ESM imports to CommonJS require via emitter path", () => {
    const esm = 'import { a } from "foo";\nexport const b = a + 1;';
    const result = transpileModuleSource(esm, "/lib/foo.mjs");
    expect(result.code).toContain('require("foo")');
    expect(result.code).not.toContain("import ");
    expect(result.exportNames).toContain("b");
  });

  it("preserves JavaScript for-in loops when transpiling bundled modules", () => {
    const esm = "export function firstKey(obj) {\n  let key;\n  for (key in obj) return key;\n}\n";
    const result = transpileModuleSource(esm, "/lib/iterate.mjs");
    expect(result.code).toContain("for (key in obj)");
    expect(result.code).not.toContain("for (const key of obj)");
  });

  it("handles export { name as default } via the emitter path", () => {
    const esm = 'const impl=()=>7;\nexport{impl as default};\n';
    const result = transpileModuleSource(esm, "/lib/render.mjs");
    expect(result.code).toContain("exports.default = impl");
    expect(result.code).toContain("exports.__esModule = true");
  });

  it("handles re-exports from another module via the emitter path", () => {
    const esm = 'export { version } from "./shared.js";\nexport { default } from "./shared.js";\n';
    const result = transpileModuleSource(esm, "/lib/render.js");
    expect(result.code).toContain('require("./shared.js")');
    expect(result.code).toContain("exports.version");
    expect(result.code).toContain("exports.default");
    expect(result.exportNames).toContain("version");
    expect(result.exportNames).toContain("default");
  });

  it("handles namespace re-exports via the emitter path", () => {
    const esm = 'export * as widgets from "./shared.js";\n';
    const result = transpileModuleSource(esm, "/lib/render.js");
    expect(result.code).toContain('const __vexa_export_0 = require("./shared.js");');
    expect(result.code).toContain("exports.widgets = __vexa_export_0;");
    expect(result.exportNames).toContain("widgets");
  });

  it("handles anonymous default function exports via the emitter path", () => {
    const esm = "export default function () { return 7; }\n";
    const result = transpileModuleSource(esm, "/lib/render.mjs");
    expect(result.code).toContain("exports.default = function()");
    expect(result.code).toContain("exports.__esModule = true");
  });

  it("handles anonymous default class exports via the emitter path", () => {
    const esm = "export default class extends Base {}\n";
    const result = transpileModuleSource(esm, "/lib/render.mjs");
    expect(result.code).toContain("exports.default = class extends Base");
    expect(result.code).toContain("exports.__esModule = true");
  });

  it("handles named class expressions via the emitter path", () => {
    const esm = "const Widget = class Widget extends Base {};\nexport default Widget;\n";
    const result = transpileModuleSource(esm, "/lib/render.mjs");
    expect(result.code).toContain("const Widget = class Widget extends Base");
    expect(result.code).toContain("exports.default = Widget");
  });

  it("handles computed class fields via the emitter path", () => {
    const esm = "export default class Browser {\n  [PropertySymbol.exceptionObserver] = null;\n}\n";
    const result = transpileModuleSource(esm, "/lib/render.mjs");
    expect(result.code).toContain("[PropertySymbol.exceptionObserver] = null;");
    expect(result.code).toContain("class Browser");
    expect(result.code).toContain("exports.default = Browser");
  });

  it("handles regular expression default exports via the emitter path", () => {
    const esm = "export default /[\\0-\\x1F\\x7F-\\x9F]/;\n";
    const result = transpileModuleSource(esm, "/lib/regex.mjs");
    expect(result.code).toContain("exports.default = /[\\0-\\x1F\\x7F-\\x9F]/");
    expect(result.code).toContain("exports.__esModule = true");
  });

  it("wraps destructuring assignment expression statements from bundled JavaScript modules", () => {
    const source = '({ sizeLods: this._sizeLods, lodPlanes: this._lodPlanes } = createPlanes());\n';
    const result = transpileModuleSource(source, "/lib/render.js");
    expect(result.code).toContain('({sizeLods: this._sizeLods, lodPlanes: this._lodPlanes} = createPlanes());');
  });

  it("transpiles string literal property names in JavaScript object binding patterns", () => {
    const source = 'export function linkProps(_ref8) {\n  let {\n    "aria-current": ariaCurrentProp = "page",\n    caseSensitive = false\n  } = _ref8;\n  return ariaCurrentProp ?? caseSensitive;\n}\n';
    const result = transpileModuleSource(source, "/lib/render.js");
    expect(result.code).toContain('let { "aria-current": ariaCurrentProp = "page", caseSensitive = false } = _ref8;');
    expect(result.exportNames).toContain("linkProps");
  });
});

describe("bundleNodeModuleGraph", () => {
  it("prefers TypeScript source over an extensionless native executable", async () => {
    await withTempProject(
      {
        "main.js": 'const cli = require("./cli"); exports.value = cli.value;\n',
        "cli": "native executable bytes",
        "cli.ts": "export const value: number = 42;\n"
      },
      async (dir) => {
        const result = await bundleNodeModuleGraph(
          'const cli = require("./cli"); exports.value = cli.value;',
          join(dir, "main.js")
        );

        expect(result.code).toContain("const value = 42;");
        expect(result.code).not.toContain("native executable bytes");
      }
    );
  });

  it("bundles extensionless relative imports whose basename contains a dot", async () => {
    await withTempProject(
      {
        "main.js": 'const shared = require("./declarations.shared"); exports.value = shared.value;\n',
        "declarations.shared.ts": "export const value: number = 42;\n"
      },
      async (dir) => {
        const entryPath = join(dir, "main.js");
        const result = await bundleNodeModuleGraph(
          'const shared = require("./declarations.shared"); exports.value = shared.value;',
          entryPath
        );

        expect(result.code).toContain('const value = 42;');
        expect(result.code).not.toContain("Unbundled external dependency './declarations.shared'");
      }
    );
  });

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

  it("parses JavaScript ESM default function exports through the shared emitter path", async () => {
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

  it("rewrites bundled dynamic imports to bundle-managed module loading", async () => {
    await withTempProject(
      {
        "entry.mjs": 'export async function loadRenderer() { const mod = await import("pkg/auto"); return mod.value; }\n',
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          exports: {
            "./auto": {
              import: "./auto.mjs"
            }
          }
        }),
        "node_modules/pkg/auto.mjs": 'export async function loadInner() { return import("./inner.mjs"); }\nexport const value = 7;\n',
        "node_modules/pkg/inner.mjs": "export const inner = 9;\n"
      },
      async (dir) => {
        const result = await bundleNodeModuleGraph(
          'export async function loadRenderer() { const mod = await import("pkg/auto"); return mod.value; }\n',
          join(dir, "entry.mjs")
        );

        expect(result.code).toContain('__vexaImport("pkg/auto")');
        expect(result.code).toContain('__vexaImport("./inner.mjs")');
        expect(result.code).not.toContain('import("./inner.mjs")');
        expect(result.code).toContain("async function __vexaImportFrom(importerId, specifier)");
      }
    );
  });

  it("does not corrupt bundled warning strings that mention import() examples", async () => {
    await withTempProject(
      {
        "entry.mjs": 'import { warning, loadInner } from "pkg/runtime"; export const value = warning; export async function load() { return loadInner(); }\n',
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          exports: {
            "./runtime": {
              import: "./runtime.js"
            }
          }
        }),
        "node_modules/pkg/runtime.js": [
          'export const warning = "lazy: Expected the result of a dynamic import() call. Your code should look like: lazy(() => import(\'./MyComponent\'))";',
          'export async function loadInner() {',
          '  return import("./inner.js");',
          '}'
        ].join("\n"),
        "node_modules/pkg/inner.js": "export const inner = 9;\n"
      },
      async (dir) => {
        const result = await bundleNodeModuleGraph(
          'import { warning, loadInner } from "pkg/runtime"; export const value = warning; export async function load() { return loadInner(); }\n',
          join(dir, "entry.mjs")
        );

        expect(result.code).toContain('lazy(() => import(\'./MyComponent\'))');
        expect(result.code).toContain('__vexaImport("./inner.js")');
        expect(result.code).not.toContain('__vexaImport("./MyComponent")');
      }
    );
  });

  it("injects a browser-safe process shim for bundled CommonJS packages", async () => {
    await withTempProject(
      {
        "entry.mjs": 'import { mode } from "pkg/runtime"; export const value = mode;\n',
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          exports: {
            "./runtime": {
              import: "./runtime.js"
            }
          }
        }),
        "node_modules/pkg/runtime.js": "export const mode = process.env.NODE_ENV;\n"
      },
      async (dir) => {
        const result = await bundleNodeModuleGraph(
          'import { mode } from "pkg/runtime"; export const value = mode;\n',
          join(dir, "entry.mjs")
        );

        expect(result.code).toContain('const process = globalThis.process ?? { env: { NODE_ENV: "production" } };');
        expect(result.code).toContain("const mode = process.env.NODE_ENV;");
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

  it("supports bundled JavaScript ESM namespace re-exports through the shared emitter path", async () => {
    await withTempProject(
      {
        "entry.js": 'import { widgets } from "pkg/render"; export const value = widgets.answer;\n',
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          exports: {
            "./render": {
              import: "./render.js"
            }
          }
        }),
        "node_modules/pkg/render.js": 'export * as widgets from "./shared.js";\n',
        "node_modules/pkg/shared.js": "export const answer = 7;\n"
      },
      async (dir) => {
        const result = await bundleNodeModuleGraph(
          'import { widgets } from "pkg/render"; export const value = widgets.answer;\n',
          join(dir, "entry.js")
        );

        expect(result.code).toContain('const __vexa_export_0 = require("./shared.js");');
        expect(result.code).toContain("exports.widgets = __vexa_export_0;");
        expect(result.code).toContain('const { widgets } = require("pkg/render");');
      }
    );
  });

  it("invalidates cached bundled module artifacts when a node_modules file changes", async () => {
    await withTempProject(
      {
        "entry.js": 'const value = require("pkg/value"); module.exports.value = value.value;\n',
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          exports: {
            ".": "./value.js",
            "./value": "./value.js"
          }
        }),
        "node_modules/pkg/value.js": "exports.value = 1;\n"
      },
      async (dir) => {
        const entryPath = join(dir, "entry.js");
        const valuePath = join(dir, "node_modules/pkg/value.js");
        const first = await bundleNodeModuleGraph(
          'const value = require("pkg/value"); module.exports.value = value.value;\n',
          entryPath
        );
        expect(first.code).toContain("exports.value = 1;");

        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        await writeFile(valuePath, "exports.value = 2;\n", "utf8");

        const second = await bundleNodeModuleGraph(
          'const value = require("pkg/value"); module.exports.value = value.value;\n',
          entryPath
        );
        expect(second.code).toContain("exports.value = 2;");
      }
    );
  });

  it("reuses an incremental dependency graph until a dependency is invalidated", async () => {
    await withTempProject(
      {
        "entry.js": 'const value = require("pkg/value"); module.exports.value = value.value;\n',
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          exports: { "./value": "./value.js" }
        }),
        "node_modules/pkg/value.js": "exports.value = 1;\n"
      },
      async (dir) => {
        const entryPath = join(dir, "entry.js");
        const valuePath = join(dir, "node_modules/pkg/value.js");
        const cache = createNodeModuleBundleIncrementalCache();
        const first = await bundleNodeModuleGraph(
          'const value = require("pkg/value"); module.exports.value = value.value;\n',
          entryPath,
          { incrementalCache: cache, changedFiles: [entryPath] }
        );
        expect(first.code).toContain("exports.value = 1;");

        await writeFile(valuePath, "exports.value = 2;\n", "utf8");
        const entryOnly = await bundleNodeModuleGraph(
          'const value = require("pkg/value"); module.exports.value = value.value + 1;\n',
          entryPath,
          { incrementalCache: cache, changedFiles: [entryPath] }
        );
        expect(entryOnly.code).toContain("exports.value = 1;");
        expect(entryOnly.code).toContain("value.value + 1");

        const dependencyChanged = await bundleNodeModuleGraph(
          'const value = require("pkg/value"); module.exports.value = value.value + 1;\n',
          entryPath,
          { incrementalCache: cache, changedFiles: [valuePath] }
        );
        expect(dependencyChanged.code).toContain("exports.value = 2;");
      }
    );
  });

  it("resolves transitive pnpm virtual-store dependencies for bundled packages", async () => {
    await withTempProject(
      {
        "entry.js": 'import { value } from "pkg"; export const doubled = value * 2;\n',
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          module: "./index.mjs"
        }),
        "node_modules/pkg/index.mjs": 'export { value } from "@scope/dep";\n',
        "node_modules/.pnpm/@scope+dep@1.0.0/node_modules/@scope/dep/package.json": JSON.stringify({
          name: "@scope/dep",
          module: "./index.mjs"
        }),
        "node_modules/.pnpm/@scope+dep@1.0.0/node_modules/@scope/dep/index.mjs": "export const value = 7;\n"
      },
      async (dir) => {
        const result = await bundleNodeModuleGraph(
          'import { value } from "pkg"; export const doubled = value * 2;\n',
          join(dir, "entry.js")
        );

        expect(result.code).toContain('"@scope/dep":"__vexa_module_1"');
        expect(result.code).toContain("const value = 7;");
        expect(result.code).toContain("exports.value = value;");
        expect(result.code).not.toContain('Unbundled external dependency "@scope/dep"');
      }
    );
  });
});
