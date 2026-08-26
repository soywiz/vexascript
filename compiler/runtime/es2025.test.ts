import { NodeKind } from "compiler/ast/ast";
import ts from "typescript";
import { describe, expect, it, join, readFile, readdir } from "../test/expect";
import { ensureVexaScriptRuntimeProgram } from "./ecmascriptDeclarations";
import {
  ECMA_SCRIPT_RUNTIME_DECLARATIONS,
  VEXA_SCRIPT_RUNTIME_DECLARATIONS
} from "./embeddedRuntimeSources";
import {
  NATIVE_STANDARD_LIBRARY_FAMILIES,
  NATIVE_STANDARD_LIBRARY_GLOBAL_FUNCTIONS,
  NATIVE_STANDARD_LIBRARY_NAMESPACE_POLICY,
  nativeStandardLibraryUnsupportedReason,
} from "./nativeStandardLibraryCoverage";

function readBundledRuntime(): Promise<string> {
  return readFile(join(process.cwd(), "compiler", "runtime", "es2025.d.ts"), "utf8");
}

async function readNativeStandardLibrarySmoke(): Promise<string> {
  const sampleRoot = join(process.cwd(), "samples", "native-language-smoke");
  const moduleRoot = join(sampleRoot, "standard-library");
  const moduleNames = (await readdir(moduleRoot))
    .filter((name) => name.endsWith(".vx"))
    .sort();
  const sources = await Promise.all([
    readFile(join(sampleRoot, "standard-library.vx"), "utf8"),
    ...moduleNames.map((name) => readFile(join(moduleRoot, name), "utf8")),
  ]);
  return sources.join("\n");
}

function declaredInterfaceMembers(source: string): ReadonlyMap<string, ReadonlySet<string>> {
  const sourceFile = ts.createSourceFile("es2025.d.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result = new Map<string, Set<string>>();
  const collect = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) {
      const names = result.get(node.name.text) ?? new Set<string>();
      for (const member of node.members) {
        const name = member.name && (
          ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)
        ) ? member.name.text : null;
        if (name && name !== "prototype") names.add(name);
      }
      result.set(node.name.text, names);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  return result;
}

function coveredStandardApiMembers(source: string, owner: string): string[] {
  const names = new Set<string>();
  const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const label of source.matchAll(new RegExp(`"${escapedOwner}\\.([^"\\n]+)"`, "g"))) {
    if (label[1]) names.add(label[1]);
  }
  return [...names].sort();
}

function declaredTopLevelFunctions(source: string): string[] {
  const sourceFile = ts.createSourceFile("es2025.d.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return [...new Set(sourceFile.statements
    .filter(ts.isFunctionDeclaration)
    .map((statement) => statement.name?.text)
    .filter((name): name is string => Boolean(name)))].sort();
}

function declaredTopLevelVariables(source: string): string[] {
  const sourceFile = ts.createSourceFile("es2025.d.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return [...new Set(sourceFile.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .map((declaration) => ts.isIdentifier(declaration.name) ? declaration.name.text : null)
    .filter((name): name is string => Boolean(name)))].sort();
}

function declaredNamespaceRuntimeMembers(source: string, namespaceName: string): string[] {
  const sourceFile = ts.createSourceFile("es2025.d.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set<string>();
  const collectBody = (node: ts.Node | undefined): void => {
    if (!node) return;
    if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text);
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) names.add(declaration.name.getText(sourceFile));
    }
    ts.forEachChild(node, collectBody);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isModuleDeclaration(statement) && statement.name.getText(sourceFile) === namespaceName) {
      collectBody(statement.body);
    }
  }
  return [...names].sort();
}

describe("bundled es2025 runtime declarations", () => {
  it("provides a parser-compatible TypeScript runtime surface", async () => {
    const source = await readBundledRuntime();

    expect(source).not.toContain('/// <reference lib="');
    expect(source).toContain("interface Array<T>");
    expect(source).toContain("interface PromiseConstructor");
    expect(source).toContain("interface Performance");
    expect(source).toContain("declare var performance: Performance;");
    expect(source).toContain("declare var Uint8Array: Uint8ArrayConstructor;");
    expect(source).toContain("try<T, U extends unknown[]>(callbackFn: (...args: U) => T | PromiseLike<T>, ...args: U): Promise<Awaited<T>>;");
  });

  it("stays focused on runtime globals rather than browser host libs", async () => {
    const source = await readBundledRuntime();

    expect(source).not.toContain("interface Document");
    expect(source).not.toContain("interface DedicatedWorkerGlobalScope");
    expect(source).not.toContain("declare var ActiveXObject");
  });

  it("locks every native ECMAScript family to execution or an explicit unsupported policy", async () => {
    const declarations = await readBundledRuntime();
    const declaredByInterface = declaredInterfaceMembers(declarations);
    const standardLibrarySmoke = await readNativeStandardLibrarySmoke();
    const mainSmoke = await readFile(
      join(process.cwd(), "samples", "native-language-smoke", "main.vx"),
      "utf8"
    );

    for (const policy of NATIVE_STANDARD_LIBRARY_FAMILIES) {
      const owner = policy.owner;
      const declared = new Set<string>();
      for (const interfaceName of policy.declarationInterfaces) {
        for (const member of declaredByInterface.get(interfaceName) ?? []) declared.add(member);
      }
      for (const member of policy.additionalDeclarationMembers ?? []) declared.add(member);
      const executed = new Set(
        coveredStandardApiMembers(standardLibrarySmoke, owner).filter((member) => declared.has(member))
      );
      const unsupported = policy.unsupportedFamilyReason
        ? declared
        : new Set(policy.unsupportedMembers ?? []);
      expect([...executed].filter((member) => unsupported.has(member))).toEqual([]);
      expect([...executed, ...unsupported].sort()).toEqual([...declared].sort());
    }
    const declaredGlobals = declaredTopLevelFunctions(declarations);
    const executedGlobals = new Set(coveredStandardApiMembers(standardLibrarySmoke, "global"));
    expect(Object.keys(NATIVE_STANDARD_LIBRARY_GLOBAL_FUNCTIONS).sort()).toEqual(declaredGlobals);
    for (const [name, reason] of Object.entries(NATIVE_STANDARD_LIBRARY_GLOBAL_FUNCTIONS)) {
      expect(reason !== null || executedGlobals.has(name)).toBe(true);
    }
    const uncoveredGlobalVariables = declaredTopLevelVariables(declarations).filter((name) =>
      !standardLibrarySmoke.includes(`"global.${name}"`) &&
      nativeStandardLibraryUnsupportedReason(name) === null
    );
    expect(uncoveredGlobalVariables).toEqual([]);
    for (const [namespaceName, policy] of Object.entries(NATIVE_STANDARD_LIBRARY_NAMESPACE_POLICY)) {
      expect(Object.keys(policy).sort()).toEqual(declaredNamespaceRuntimeMembers(declarations, namespaceName));
      for (const [member, reason] of Object.entries(policy)) {
        if (reason === null) expect(standardLibrarySmoke).toContain(`"${namespaceName}.${member}.`);
      }
    }
    expect(mainSmoke).toContain('from "./standard-library.vx"');
    expect(mainSmoke).toContain("runNativeStandardLibrarySmoke()");
  });

  it("keeps VexaScript-specific annotation declarations in the dedicated runtime file", async () => {
    const program = await ensureVexaScriptRuntimeProgram();
    const names = program.body
      .filter((statement) => statement.kind === NodeKind.AnnotationStatement)
      .map((statement) => (statement as unknown as { name: { name: string } }).name.name);

    expect(names).toContain("JsName");
    expect(names).toContain("JsInline");
    expect(names).toContain("CppHeader");
    expect(names).toContain("CppFlags");
    expect(names).toContain("CppBody");
    expect(names).toContain("FFILibrary");
    expect(names).toContain("FFIName");
    expect(names).toContain("FFIStruct");
    expect(names).toContain("FFIAlign");
    expect(names).toContain("FFIOffset");
    expect(names).toContain("FFISize");
  });

  it("loads each declaration file through direct text-module imports", async () => {
    const vexaSource = await readFile(join(process.cwd(), "compiler", "runtime", "vexascript.d.vx"), "utf8");
    const sourceModule = await readFile(join(process.cwd(), "compiler", "runtime", "embeddedRuntimeSources.ts"), "utf8");

    expect(ECMA_SCRIPT_RUNTIME_DECLARATIONS).toBe(await readBundledRuntime());
    expect(VEXA_SCRIPT_RUNTIME_DECLARATIONS).toBe(vexaSource);
    expect(sourceModule).toContain('from "./es2025.d.ts?text"');
    expect(sourceModule).toContain('from "./vexascript.d.vx?text"');
    expect(sourceModule).not.toContain("`/*!");
  });
});
