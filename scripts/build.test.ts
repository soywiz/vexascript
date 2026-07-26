import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "../compiler/test/expect";
import { buildDistribution } from "./build";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("distribution build", () => {
  it("creates the bundled CLI and copies its runtime declarations without shell utilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-build-"));
    temporaryDirectories.push(root);
    const runtimeDir = join(root, "runtime");
    const outputDir = join(root, "dist");
    const entryPoint = join(root, "entry.ts");
    const textModulePath = join(root, "runtime-source.d.ts");
    await mkdir(runtimeDir);
    await writeFile(
      entryPoint,
      'import runtimeSource from "./runtime-source.d.ts?text";\nconsole.log("portable build", runtimeSource);\n',
      "utf8"
    );
    await Promise.all([
      writeFile(textModulePath, "declare const textModulePluginWorks: true;\n", "utf8"),
      writeFile(join(runtimeDir, "es2025.d.ts"), "declare const es2025: true;\n", "utf8"),
      writeFile(join(runtimeDir, "dom.d.ts"), "declare const dom: true;\n", "utf8"),
      writeFile(join(runtimeDir, "vexascript.d.vx"), "declare const vexa: true;\n", "utf8"),
    ]);

    await buildDistribution({ entryPoint, outputDir, runtimeDir });

    const bundle = await readFile(join(outputDir, "vexa.js"), "utf8");
    expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(bundle).toContain("portable build");
    expect(bundle).toContain("textModulePluginWorks");
    expect(await readFile(join(outputDir, "es2025.d.ts"), "utf8")).toContain("es2025");
    expect(await readFile(join(outputDir, "dom.d.ts"), "utf8")).toContain("dom");
    expect(await readFile(join(outputDir, "vexascript.d.vx"), "utf8")).toContain("vexa");
    expect((await stat(join(outputDir, "vexa.js.map"))).isFile()).toBe(true);

    if (process.platform !== "win32") {
      expect((await stat(join(outputDir, "vexa.js"))).mode & 0o111).not.toBe(0);
    }
  });
});
