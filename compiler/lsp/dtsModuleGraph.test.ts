import { describe, expect, it } from "../test/expect";
import { extractTripleSlashReferencePaths } from "./dtsModuleGraph";

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
