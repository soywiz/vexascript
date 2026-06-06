import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { readFileSync } from "node:fs";
import {
  getEcmaScriptRuntimeDeclarationFilePath,
  getEcmaScriptRuntimeProgram,
  isEcmaScriptRuntimeNode,
  TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME
} from "./ecmascriptDeclarations";

describe("TypeScript runtime declarations", () => {
  it("loads the bundled es2025 declaration file as the runtime source", () => {
    expect(getEcmaScriptRuntimeDeclarationFilePath().endsWith(TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME)).toBe(true);
  });

  it("parses the bundled runtime and exposes ambient globals from TypeScript libs", () => {
    const program = getEcmaScriptRuntimeProgram();
    const source = readFileSync(getEcmaScriptRuntimeDeclarationFilePath(), "utf8");

    expect(program.body.length > 0).toBe(true);
    expect(source).toContain("interface Array<T>");
    expect(source).toContain("declare global {");
    expect(source).toContain("interface IteratorObject<T, TReturn, TNext>");
  });

  it("reuses the cached runtime program and runtime node index between calls", () => {
    const first = getEcmaScriptRuntimeProgram();
    const second = getEcmaScriptRuntimeProgram();

    expect(first).toBe(second);
    expect(isEcmaScriptRuntimeNode(first.body[0]!)).toBe(true);
  });
});
