import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripBundledCommonJsImports,
  stripBundledImports,
  stripBundledModuleSyntax,
} from "./bundlingStripping";

describe("stripBundledImports", () => {
  it("removes an import line whose specifier is in the bundled set", () => {
    const code = [
      `import { foo } from "./local";`,
      `const x = 1;`,
    ].join("\n");
    const result = stripBundledImports(code, new Set(["./local"]));
    assert.equal(result, `const x = 1;`);
  });

  it("keeps an import line whose specifier is not bundled", () => {
    const code = `import { foo } from "external";`;
    const result = stripBundledImports(code, new Set(["./local"]));
    assert.equal(result, code);
  });

  it("removes side-effect imports to bundled specifiers", () => {
    const code = `import "./bundled";\nconst x = 1;`;
    const result = stripBundledImports(code, new Set(["./bundled"]));
    assert.equal(result, `const x = 1;`);
  });

  it("handles an empty bundled set without modifying code", () => {
    const code = `import { x } from "./a";`;
    const result = stripBundledImports(code, new Set());
    assert.equal(result, code);
  });

  it("removes multiple bundled imports", () => {
    const code = [
      `import { a } from "./a";`,
      `import { b } from "./b";`,
      `import { c } from "external";`,
    ].join("\n");
    const result = stripBundledImports(code, new Set(["./a", "./b"]));
    assert.equal(result, `import { c } from "external";`);
  });
});

describe("stripBundledModuleSyntax", () => {
  it("strips bundled imports and export modifiers", () => {
    const code = [
      `import { a } from "./bundled";`,
      `export function foo() {}`,
      `export default 42;`,
    ].join("\n");
    const result = stripBundledModuleSyntax(code, new Set(["./bundled"]));
    assert.match(result, /function foo\(\)/);
    assert.doesNotMatch(result, /export function/);
    assert.doesNotMatch(result, /import.*bundled/);
  });

  it("removes named export clauses when preserveExports is false", () => {
    const code = `export { foo, bar };`;
    const result = stripBundledModuleSyntax(code, new Set());
    assert.equal(result.trim(), "");
  });

  it("preserves export clauses when preserveExports is true", () => {
    const code = `export { foo, bar };`;
    const result = stripBundledModuleSyntax(code, new Set(), { preserveExports: true });
    assert.equal(result.trim(), code.trim());
  });

  it("strips export = assignments when preserveExports is false", () => {
    const code = `export = module;`;
    const result = stripBundledModuleSyntax(code, new Set());
    assert.equal(result.trim(), "");
  });

  it("removes export and default keywords from default export declaration", () => {
    const code = `export default function greet() {}`;
    const result = stripBundledModuleSyntax(code, new Set());
    assert.match(result, /^function greet/m);
    assert.doesNotMatch(result, /export/);
  });
});

describe("stripBundledCommonJsImports", () => {
  it("returns code unchanged when bundled set is empty", () => {
    const code = `const x = require("./a");`;
    const result = stripBundledCommonJsImports(code, new Set());
    assert.equal(result, code);
  });

  it("removes a direct require call for a bundled specifier", () => {
    const code = [`require("./bundled");`, `const x = 1;`].join("\n");
    const result = stripBundledCommonJsImports(code, new Set(["./bundled"]));
    assert.equal(result, `const x = 1;`);
  });

  it("removes a temp-binding require and its deriving const", () => {
    const code = [
      `const _mod = require("./bundled");`,
      `const foo = _mod.foo;`,
      `const x = 1;`,
    ].join("\n");
    const result = stripBundledCommonJsImports(code, new Set(["./bundled"]));
    assert.equal(result, `const x = 1;`);
  });

  it("keeps require calls for non-bundled specifiers", () => {
    const code = `const ext = require("external");`;
    const result = stripBundledCommonJsImports(code, new Set(["./bundled"]));
    assert.equal(result, code);
  });

  it("removes multiple bundled require calls", () => {
    const code = [
      `const a = require("./a");`,
      `const b = require("./b");`,
      `const c = require("external");`,
    ].join("\n");
    const result = stripBundledCommonJsImports(code, new Set(["./a", "./b"]));
    assert.equal(result, `const c = require("external");`);
  });
});
