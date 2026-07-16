import type { ImportStatement, Program, Statement } from "compiler/ast/ast";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { compileParsedSource } from "compiler/pipeline/compile";
import { parseSource, type ParseArtifacts } from "compiler/pipeline/parse";
import { vfs, type Vfs } from "compiler/vfs";
import {
  localImportSpecifiers,
  parserOptionsForModulePath,
  type ModuleGraphOptions,
} from "./moduleGraph";
import { transpile, type TranspileResult, type TranspileTarget } from "./transpile";

export interface NativeModuleGraphResult extends TranspileResult {
  watchedFiles: string[];
}

function nativeModuleStatements(program: Program): Statement[] {
  return program.body.flatMap((statement) => {
    if (statement.kind === "ImportStatement") return [];
    const declaration = unwrapExportedDeclaration(statement);
    return declaration ? [declaration] : [];
  });
}

function unsupportedImportMessage(statement: ImportStatement): string | null {
  if (statement.defaultImport || statement.namespaceImport) {
    return "Native C++ modules currently support named and side-effect imports only";
  }
  const alias = statement.specifiers.find((specifier) =>
    specifier.local && specifier.local.name !== specifier.imported.name);
  return alias
    ? `Native C++ modules do not support import aliases yet ('${alias.imported.name}' as '${alias.local!.name}')`
    : null;
}

/**
 * Loads local VexaScript/TypeScript modules through the shared module resolver,
 * then analyzes and emits their declarations and entry code as one native C++
 * translation unit. Dependency top-level code remains in dependency order.
 */
export async function compileNativeModuleGraph(
  entryFilePath: string,
  target: TranspileTarget,
  options: ModuleGraphOptions = {}
): Promise<NativeModuleGraphResult> {
  const activeVfs: Vfs = options.vfs ?? vfs();
  const importMappings = options.importMappings ?? {};
  const parsedByPath = new Map<string, ParseArtifacts>();
  const sourceByPath = new Map<string, string>();
  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const errors: string[] = [];

  const visit = async (filePath: string): Promise<void> => {
    if (visited.has(filePath) || visiting.has(filePath)) return;
    visiting.add(filePath);
    const source = await activeVfs.readFile(filePath);
    if (source === null) {
      errors.push(`Unable to read native module '${filePath}'`);
      visiting.delete(filePath);
      return;
    }
    sourceByPath.set(filePath, source);
    const parsed = parseSource(source, parserOptionsForModulePath(filePath));
    parsedByPath.set(filePath, parsed);
    if (!parsed.ast) {
      errors.push(`Unable to parse native module '${filePath}'`);
      visiting.delete(filePath);
      return;
    }
    for (const issue of parsed.parserIssues) errors.push(`${filePath}: ${issue.message}`);
    if (parsed.tokenizeError) errors.push(`${filePath}: ${parsed.tokenizeError.message}`);
    if (parsed.fatalError) errors.push(`${filePath}: ${parsed.fatalError}`);

    for (const statement of parsed.ast.body) {
      if (statement.kind !== "ImportStatement") continue;
      const unsupported = unsupportedImportMessage(statement as ImportStatement);
      if (unsupported) errors.push(unsupported);
    }
    for (const dependency of await localImportSpecifiers(
      parsed.ast,
      filePath,
      activeVfs,
      importMappings
    )) {
      await visit(dependency.targetPath);
    }
    visiting.delete(filePath);
    visited.add(filePath);
    order.push(filePath);
  };

  await visit(entryFilePath);
  const entryParsed = parsedByPath.get(entryFilePath);
  const entrySource = sourceByPath.get(entryFilePath) ?? "";
  if (!entryParsed?.ast || errors.length > 0) {
    return { code: "", warnings: [], errors, diagnostics: [], watchedFiles: [...sourceByPath.keys()] };
  }

  const mergedProgram: Program = {
    ...entryParsed.ast,
    body: order.flatMap((filePath) => nativeModuleStatements(parsedByPath.get(filePath)!.ast!)),
  };
  const compilationArtifacts = compileParsedSource({ ...entryParsed, ast: mergedProgram }, {
    ambientDeclarations: options.ambientDeclarations ?? [],
  });
  const result = transpile(entrySource, {
    compilationArtifacts,
    sourceFilePath: entryFilePath,
    target,
    emit: "cpp",
    emitSourceMap: false,
    ambientDeclarations: options.ambientDeclarations ?? [],
    ...(options.jsxFactory ? { jsxFactory: options.jsxFactory } : {}),
    ...(options.jsxFragmentFactory ? { jsxFragmentFactory: options.jsxFragmentFactory } : {}),
  });
  return { ...result, watchedFiles: order };
}
