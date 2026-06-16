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
        expect(result.code).toContain('const shared_mjs_1 = require("./shared.mjs");');
      }
    );
  });
});
