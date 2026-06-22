import { describe, expect, it } from "../test/expect";
import { parseSource } from "compiler/pipeline/parse";
import type { ImportStatement } from "compiler/ast/ast";
import {
  findImportBindingByLocalName,
  findImportForSymbolNode,
  findModuleReceiverImport,
  importStatementBindings
} from "./crossFileContext";

describe("import binding enumeration", () => {
  const ast = parseSource(
    [
      `import def from "m1"`,
      `import * as ns from "m2"`,
      `import { a, b as c } from "m3"`
    ].join("\n"),
    {}
  ).ast!;

  it("enumerates default imports", () => {
    const binding = findImportBindingByLocalName(ast.body, "def");
    expect(binding?.from).toBe("m1");
    expect(binding?.importedName).toBe("def");
    expect(binding?.localName).toBe("def");
  });

  it("enumerates namespace imports", () => {
    const binding = findImportBindingByLocalName(ast.body, "ns");
    expect(binding?.from).toBe("m2");
    expect(binding?.localName).toBe("ns");
  });

  it("enumerates named imports preserving exported and local names", () => {
    const named = findImportBindingByLocalName(ast.body, "a");
    expect(named?.from).toBe("m3");
    expect(named?.importedName).toBe("a");
    expect(named?.localName).toBe("a");

    const renamed = findImportBindingByLocalName(ast.body, "c");
    expect(renamed?.from).toBe("m3");
    expect(renamed?.importedName).toBe("b");
    expect(renamed?.localName).toBe("c");
  });

  it("returns null for names that are not imported", () => {
    expect(findImportBindingByLocalName(ast.body, "missing")).toBeNull();
  });

  it("yields every binding introduced by a single import statement", () => {
    const namedImport = ast.body[2] as ImportStatement;
    const bindings = [...importStatementBindings(namedImport)];
    expect(bindings.map((binding) => binding.localName)).toEqual(["a", "c"]);
    expect(bindings.map((binding) => binding.importedName)).toEqual(["a", "b"]);
  });

  it("tags each binding with the import clause that introduced it", () => {
    expect(findImportBindingByLocalName(ast.body, "def")?.kind).toBe("default");
    expect(findImportBindingByLocalName(ast.body, "ns")?.kind).toBe("namespace");
    expect(findImportBindingByLocalName(ast.body, "a")?.kind).toBe("named");
    expect(findImportBindingByLocalName(ast.body, "c")?.kind).toBe("named");
  });
});

describe("findImportForSymbolNode", () => {
  it("matches the local node of a renamed specifier", () => {
    const ast = parseSource(`import { b as c } from "m3"`, {}).ast!;
    const specifier = (ast.body[0] as ImportStatement).specifiers[0]!;
    const byLocal = findImportForSymbolNode(ast, specifier.local);
    expect(byLocal?.from).toBe("m3");
    expect(byLocal?.name).toBe("b");
    expect(byLocal?.localName).toBe("c");
  });

  it("also matches the imported node of a renamed specifier", () => {
    const ast = parseSource(`import { b as c } from "m3"`, {}).ast!;
    const specifier = (ast.body[0] as ImportStatement).specifiers[0]!;
    const byImported = findImportForSymbolNode(ast, specifier.imported);
    expect(byImported?.name).toBe("b");
    expect(byImported?.localName).toBe("c");
  });
});

describe("findModuleReceiverImport", () => {
  it("resolves the module for default, namespace, and named receivers", () => {
    const ast = parseSource(
      [
        `import path from "node:path"`,
        `import * as fs from "node:fs"`,
        `import { join } from "node:url"`
      ].join("\n"),
      {}
    ).ast!;
    expect(findModuleReceiverImport(ast, "path")?.from).toBe("node:path");
    expect(findModuleReceiverImport(ast, "fs")?.from).toBe("node:fs");
    expect(findModuleReceiverImport(ast, "join")?.from).toBe("node:url");
    expect(findModuleReceiverImport(ast, "other")).toBeNull();
  });
});
