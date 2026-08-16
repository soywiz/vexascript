import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "../test/expect";
import { extractTripleSlashReferencePaths, resolveRelativeDtsPath } from "./dtsModuleGraph";

describe("extractTripleSlashReferencePaths", () => {
  it("extracts double-quoted reference paths", () => {
    expect(extractTripleSlashReferencePaths(`/// <reference path="./a.d.ts" />\n`)).toEqual(["./a.d.ts"]);
  });

  it("extracts single-quoted reference paths (previously missed by the ambient loader)", () => {
    expect(extractTripleSlashReferencePaths(`/// <reference path='./b.d.ts' />\n`)).toEqual(["./b.d.ts"]);
  });

  it("tolerates leading whitespace before the directive", () => {
    expect(extractTripleSlashReferencePaths(`  /// <reference path="./c.d.ts" />\n`)).toEqual(["./c.d.ts"]);
  });

  it("de-duplicates while preserving source order", () => {
    const source = `/// <reference path="./a" />\n/// <reference path="./b" />\n/// <reference path="./a" />\n`;
    expect(extractTripleSlashReferencePaths(source)).toEqual(["./a", "./b"]);
  });

  it("ignores ordinary comments and code", () => {
    expect(extractTripleSlashReferencePaths(`// just a comment\nconst x = 1;\n`)).toEqual([]);
  });
});

describe("resolveRelativeDtsPath", () => {
  it("preserves CommonJS and ESM declaration formats when resolving JavaScript specifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-dts-module-format-"));
    const ctsPath = join(root, "external.d.cts");
    const mtsPath = join(root, "external.d.mts");
    const tsPath = join(root, "external.d.ts");
    await Promise.all([
      writeFile(ctsPath, "export declare const cts: true\n", "utf8"),
      writeFile(mtsPath, "export declare const mts: true\n", "utf8"),
      writeFile(tsPath, "export declare const ts: true\n", "utf8")
    ]);

    expect(await resolveRelativeDtsPath(join(root, "index.d.cts"), "./external.cjs")).toBe(ctsPath);
    expect(await resolveRelativeDtsPath(join(root, "index.d.mts"), "./external.mjs")).toBe(mtsPath);
    expect(await resolveRelativeDtsPath(join(root, "index.d.ts"), "./external.js")).toBe(tsPath);
  });
});
