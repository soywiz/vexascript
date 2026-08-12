const { readFile } = require("node:fs/promises");
const { resolve } = require("node:path");
const { describe, it } = require("node:test");
const { expect } = require("../../compiler/test/expect");
const {
  configSchemaPathForProperty,
  findConfigSchemaDefinition,
  findJsonPropertyPathAtOffset,
  findJsonPropertyRangeAtPath
} = require("./jsonSchemaDefinition.js");

function offsetInside(source, needle) {
  const offset = source.indexOf(needle);
  if (offset < 0) {
    throw new Error(`Missing test marker: ${needle}`);
  }
  return offset + 2;
}

describe("VS Code vexascript.json schema definitions", () => {
  it("resolves top-level and nested configuration keys under the cursor", () => {
    const source = `{
      "entrypoint": "src/main.vx",
      "compilerOptions": {
        "lib": ["es2025", "dom"]
      },
      "canonicalSyntax": {
        "functionDeclaration": "func"
      }
    }`;

    expect(findJsonPropertyPathAtOffset(source, offsetInside(source, "entrypoint"))).toEqual(["entrypoint"]);
    expect(findJsonPropertyPathAtOffset(source, offsetInside(source, "lib"))).toEqual(["compilerOptions", "lib"]);
    expect(findJsonPropertyPathAtOffset(source, offsetInside(source, "functionDeclaration"))).toEqual([
      "canonicalSyntax",
      "functionDeclaration"
    ]);
    expect(findJsonPropertyPathAtOffset(source, source.indexOf("src/main.vx"))).toBeUndefined();
  });

  it("maps configuration paths to concrete schema nodes", () => {
    expect(configSchemaPathForProperty(["entrypoint"])).toEqual(["properties", "entrypoint"]);
    expect(configSchemaPathForProperty(["compilerOptions", "lib"])).toEqual([
      "properties",
      "compilerOptions",
      "properties",
      "lib"
    ]);
    expect(configSchemaPathForProperty(["globalSymbols", "emit"])).toEqual([
      "properties",
      "globalSymbols",
      "oneOf",
      1,
      "properties",
      "emit"
    ]);
    expect(configSchemaPathForProperty(["importMappings", "@app/state"])).toEqual([
      "properties",
      "importMappings",
      "additionalProperties"
    ]);
    expect(configSchemaPathForProperty(["serveMappings", "public/assets"])).toEqual([
      "properties",
      "serveMappings",
      "oneOf",
      0,
      "additionalProperties"
    ]);
    expect(configSchemaPathForProperty(["serveMappings", 0, "from"])).toEqual([
      "properties",
      "serveMappings",
      "oneOf",
      1,
      "items",
      "properties",
      "from"
    ]);
    expect(configSchemaPathForProperty(["unknown"])).toBeUndefined();
  });

  it("finds the target key range in the packaged schema", async () => {
    const schema = await readFile(
      resolve(process.cwd(), "plugins", "vscode", "schemas", "vexascript.schema.json"),
      "utf8"
    );
    const range = findJsonPropertyRangeAtPath(schema, [
      "properties",
      "compilerOptions",
      "properties",
      "jsxFactory"
    ]);

    expect(range).toBeDefined();
    expect(schema.slice(range.start, range.end)).toBe('"jsxFactory"');
  });

  it("resolves the complete definition target used by the extension", async () => {
    const schema = await readFile(
      resolve(process.cwd(), "plugins", "vscode", "schemas", "vexascript.schema.json"),
      "utf8"
    );
    const config = '{ "compilerOptions": { "jsxFactory": "h" } }';
    const definition = findConfigSchemaDefinition(
      config,
      offsetInside(config, "jsxFactory"),
      schema
    );

    expect(definition).toBeDefined();
    expect(schema.slice(definition.range.start, definition.range.end)).toBe('"jsxFactory"');
  });
});
