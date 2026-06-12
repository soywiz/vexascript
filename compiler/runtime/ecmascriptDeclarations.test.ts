import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getEcmaScriptRuntimeDeclarationFilePath,
  getEcmaScriptRuntimeProgram,
  getVexaScriptRuntimeDeclarationFilePath,
  getVexaScriptRuntimeProgram,
  isEcmaScriptRuntimeNode,
  isVexaScriptRuntimeNode,
  TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME
} from "./ecmascriptDeclarations";

describe("TypeScript runtime declarations", () => {
  it("loads the bundled es2025 declaration file as the runtime source", async () => {
    expect(getEcmaScriptRuntimeDeclarationFilePath().endsWith(TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME)).toBe(true);
  });

  it("parses the bundled runtime and exposes ambient globals from TypeScript libs", async () => {
    const program = getEcmaScriptRuntimeProgram();
    const source = await readFile(getEcmaScriptRuntimeDeclarationFilePath(), "utf8");

    expect(program.body.length > 0).toBe(true);
    expect(source).toContain("interface Array<T>");
    expect(source).toContain("declare global {");
    expect(source).toContain("interface IteratorObject<T, TReturn, TNext>");
  });

  it("reuses the cached runtime program and runtime node index between calls", async () => {
    const first = getEcmaScriptRuntimeProgram();
    const second = getEcmaScriptRuntimeProgram();

    expect(first).toBe(second);
    expect(isEcmaScriptRuntimeNode(first.body[0]!)).toBe(true);
  });

  it("loads VexaScript-specific runtime annotations from a dedicated .d.vx file", async () => {
    const program = getVexaScriptRuntimeProgram();

    expect(getVexaScriptRuntimeDeclarationFilePath().endsWith("vexascript.d.vx")).toBe(true);
    expect(program.body.some((statement) => statement.kind === "AnnotationStatement")).toBe(true);
    expect(isVexaScriptRuntimeNode(program.body[0]!)).toBe(true);
  });

  it("boots the Node VFS from the Node declaration host", async () => {
    const source = await readFile(join(process.cwd(), "compiler", "runtime", "nodeDeclarationHost.ts"), "utf8");

    expect(source).toContain('import "compiler/localVfs";');
  });
});
