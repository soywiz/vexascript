import type {
  ExportStatement,
  Identifier,
  ImportStatement,
  MemberExpression,
  Node,
  Program,
  Statement,
  VarStatement,
} from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { childNodes, unwrapExportedDeclaration } from "compiler/ast/traversal";
import { substituteTypeNameText } from "compiler/analysis/typeNames";
import { compileParsedSource } from "compiler/pipeline/compile";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import { parseSource, type ParseArtifacts } from "compiler/pipeline/parse";
import { vfs, type Vfs } from "compiler/vfs";
import { resolve } from "compiler/utils/path";
import { localImportSpecifiers, parserOptionsForModulePath } from "./localModuleResolution";
import type { ModuleGraphOptions } from "./moduleGraphModel";
import { transpile, type TranspileResult, type TranspileTarget } from "./transpile";

export interface NativeModuleGraphResult extends TranspileResult {
  watchedFiles: string[];
}

function nativeModuleStatements(program: Program): Statement[] {
  return program.body.flatMap((statement) => {
    if (statement.kind === "ImportStatement") return [];
    if (statement.kind === "ExportStatement") {
      const exported = statement as ExportStatement;
      if (exported.default && exported.declaration?.kind === "ExprStatement") return [];
    }
    const declaration = unwrapExportedDeclaration(statement);
    return declaration ? [declaration] : [];
  });
}

interface NativeModuleInfo {
  path: string;
  program: Program;
  localSymbols: Map<string, string>;
  exports: Map<string, string>;
  importTargets: Map<ImportStatement, string>;
  reexportTargets: Map<ExportStatement, string>;
}

function isTypeOnlyImport(statement: ImportStatement): boolean {
  return statement.typeOnly === true || (
    !statement.defaultImport &&
    !statement.namespaceImport &&
    statement.specifiers.length > 0 &&
    statement.specifiers.every((specifier) => specifier.typeOnly === true)
  );
}

const NATIVE_SOURCE_PATH = "__vexaNativeSourcePath";

function markNativeSourcePath(node: Node, path: string): void {
  (node as unknown as Record<string, unknown>)[NATIVE_SOURCE_PATH] = path;
  for (const child of childNodes(node)) markNativeSourcePath(child, path);
}

function declarationIdentifiers(statement: Statement): Identifier[] {
  const declaration = unwrapExportedDeclaration(statement);
  if (!declaration) return [];
  if (declaration.kind === "VarStatement") {
    return bindingIdentifiers((declaration as VarStatement).name);
  }
  const name = (declaration as { name?: Identifier }).name;
  return name?.kind === "Identifier" ? [name] : [];
}

function nativeSymbolName(moduleIndex: number, sourceName: string): string {
  return `__vexa_module_${moduleIndex}_${sourceName}`;
}

function typeNameWithRenamedBase(typeName: string, names: ReadonlyMap<string, string>): string {
  return substituteTypeNameText(typeName, names);
}

function replaceNode(target: Node, replacement: Node): void {
  for (const key of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[key];
  Object.assign(target, replacement);
}

function rewriteNamespaceMembers(
  node: Node,
  resolvedSymbols: ReadonlyMap<Node, Node>,
  namespaceExports: ReadonlyMap<Node, ReadonlyMap<string, string>>
): void {
  if (node.kind === "MemberExpression") {
    const member = node as MemberExpression;
    if (!member.computed && member.object.kind === "Identifier" && member.property.kind === "Identifier") {
      const symbolNode = resolvedSymbols.get(member.object as Node);
      const targetName = symbolNode
        ? namespaceExports.get(symbolNode)?.get((member.property as Identifier).name)
        : undefined;
      if (targetName) {
        replaceNode(node, {
          kind: "Identifier",
          name: targetName,
          firstToken: node.firstToken,
          lastToken: node.lastToken,
        } as Identifier);
        return;
      }
    }
  }
  for (const child of childNodes(node)) rewriteNamespaceMembers(child, resolvedSymbols, namespaceExports);
}

const TYPE_NODE_KEYS = new Set([
  "typeAnnotation", "returnType", "extendsType", "extendsTypes", "implementsTypes",
  "targetType", "constraint", "defaultType", "receiverType", "receiverTypeArguments", "typeArguments",
]);

function rewriteTypeNames(node: Node, names: ReadonlyMap<string, string>): void {
  const record = node as unknown as Record<string, unknown>;
  for (const key of TYPE_NODE_KEYS) {
    const value = record[key];
    const identifiers = Array.isArray(value) ? value : value ? [value] : [];
    for (const candidate of identifiers) {
      if (typeof candidate === "object" && candidate !== null && (candidate as Node).kind === "Identifier") {
        const identifier = candidate as Identifier;
        identifier.name = typeNameWithRenamedBase(identifier.name, names);
      }
    }
  }
  for (const child of childNodes(node)) rewriteTypeNames(child, names);
}

function moduleInfo(program: Program, path: string, moduleIndex: number): NativeModuleInfo {
  const localSymbols = new Map<string, string>();
  const extensionSymbols = new Map<string, string>();
  for (const statement of program.body) {
    for (const identifier of declarationIdentifiers(statement)) {
      const declaration = unwrapExportedDeclaration(statement);
      if ((declaration?.kind === "FunctionStatement" || declaration?.kind === "VarStatement") &&
        (declaration as { receiverType?: Identifier }).receiverType) {
        // Extension members are imported by their source-level member name, but
        // native calls are selected from the analyzer's declaration resolution
        // and emitted with a receiver-qualified C++ name. Keep a virtual export
        // here for module validation without introducing a second naming path.
        extensionSymbols.set(identifier.name, `__vexa_extension_import_${moduleIndex}_${identifier.name}`);
        continue;
      }
      (identifier as unknown as { __vexaNativeOriginalName?: string }).__vexaNativeOriginalName = identifier.name;
      localSymbols.set(identifier.name, nativeSymbolName(moduleIndex, identifier.name));
    }
  }
  const exports = new Map([...localSymbols, ...extensionSymbols]);
  for (const statement of program.body) {
    if (statement.kind !== "ExportStatement") continue;
    const exported = statement as ExportStatement;
    const declarationNames = declarationIdentifiers(statement);
    if (exported.default && declarationNames[0]) {
      exports.set("default", localSymbols.get(declarationNames[0].name)!);
    } else if (exported.default && exported.declaration?.kind === "ExprStatement") {
      const expression = (exported.declaration as { expression?: Node }).expression;
      if (expression?.kind === "Identifier") {
        const target = localSymbols.get((expression as Identifier).name);
        if (target) exports.set("default", target);
      }
    }
    for (const specifier of exported.specifiers ?? []) {
      const localName = (specifier.local ?? specifier.exported).name;
      const target = localSymbols.get(localName) ?? extensionSymbols.get(localName);
      if (target) exports.set(specifier.exported.name, target);
    }
  }
  return { path, program, localSymbols, exports, importTargets: new Map(), reexportTargets: new Map() };
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
  const importsByPath = new Map<string, { statement: ImportStatement; targetPath: string }[]>();
  const reexportsByPath = new Map<string, { statement: ExportStatement; targetPath: string }[]>();
  const order: string[] = [];
  const visiting = new Set<string>();
  const visitStack: string[] = [];
  const visited = new Set<string>();
  const errors: string[] = [];

  const visit = async (filePath: string): Promise<void> => {
    if (visited.has(filePath) || visiting.has(filePath)) return;
    visiting.add(filePath);
    visitStack.push(filePath);
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
    markNativeSourcePath(parsed.ast, filePath);
    for (const issue of parsed.parserIssues) errors.push(`${filePath}: ${issue.message}`);
    if (parsed.tokenizeError) errors.push(`${filePath}: ${parsed.tokenizeError.message}`);
    if (parsed.fatalError) errors.push(`${filePath}: ${parsed.fatalError}`);

    const imports = await localImportSpecifiers(
      parsed.ast,
      filePath,
      activeVfs,
      importMappings,
      options.baseUrl
    );
    importsByPath.set(filePath, imports);
    const reexports: { statement: ExportStatement; targetPath: string }[] = [];
    for (const statement of parsed.ast.body) {
      if (statement.kind !== "ExportStatement" || !(statement as ExportStatement).from) continue;
      const exported = statement as ExportStatement;
      const targetPath = await resolveImportTargetFilePath(filePath, exported.from!.value, {
        vfs: activeVfs,
        importMappings,
        ...(options.baseUrl && !exported.from!.value.startsWith(".")
          ? { importMappings: { ...importMappings, [exported.from!.value]: resolve(options.baseUrl, exported.from!.value) } }
          : {}),
      });
      if (!targetPath) {
        errors.push(`Native re-export '${exported.from!.value}' from '${filePath}' did not resolve to compilable source`);
        continue;
      }
      reexports.push({ statement: exported, targetPath });
    }
    reexportsByPath.set(filePath, reexports);
    const resolvedImportStatements = new Set(imports.map((entry) => entry.statement));
    for (const statement of parsed.ast.body) {
      if (statement.kind !== "ImportStatement" || resolvedImportStatements.has(statement as ImportStatement)) {
        continue;
      }
      const specifier = (statement as ImportStatement).from.value;
      errors.push(specifier.startsWith(".")
        ? `Native import '${specifier}' from '${filePath}' did not resolve to compilable VexaScript/TypeScript source`
        : `Native package '${specifier}' has no native VexaScript/TypeScript source mapping; add it to 'imports'/'importMappings' or provide a native binding`);
    }
    for (const dependency of imports) {
      if (visiting.has(dependency.targetPath)) {
        if (!isTypeOnlyImport(dependency.statement)) {
          const cycleStart = visitStack.indexOf(dependency.targetPath);
          errors.push(`Native module initialization cycle: ${[
            ...visitStack.slice(Math.max(0, cycleStart)),
            dependency.targetPath,
          ].join(" -> ")}`);
        }
        continue;
      }
      await visit(dependency.targetPath);
    }
    for (const dependency of reexports) {
      if (visiting.has(dependency.targetPath)) {
        if (!dependency.statement.typeOnly) {
          errors.push(`Native module initialization cycle through re-export '${dependency.targetPath}'`);
        }
        continue;
      }
      await visit(dependency.targetPath);
    }
    visiting.delete(filePath);
    visitStack.pop();
    visited.add(filePath);
    order.push(filePath);
  };

  await visit(entryFilePath);
  const entryParsed = parsedByPath.get(entryFilePath);
  const entrySource = sourceByPath.get(entryFilePath) ?? "";
  if (!entryParsed?.ast || errors.length > 0) {
    return { code: "", warnings: [], errors, diagnostics: [], watchedFiles: [...sourceByPath.keys()] };
  }

  const moduleInfos = new Map<string, NativeModuleInfo>();
  order.forEach((filePath, index) => {
    moduleInfos.set(filePath, moduleInfo(parsedByPath.get(filePath)!.ast!, filePath, index));
  });
  for (const filePath of order) {
    const info = moduleInfos.get(filePath)!;
    for (const dependency of importsByPath.get(filePath) ?? []) {
      info.importTargets.set(dependency.statement, dependency.targetPath);
    }
    for (const dependency of reexportsByPath.get(filePath) ?? []) {
      info.reexportTargets.set(dependency.statement, dependency.targetPath);
    }
  }

  for (const filePath of order) {
    const info = moduleInfos.get(filePath)!;
    for (const [statement, targetPath] of info.reexportTargets) {
      const target = moduleInfos.get(targetPath);
      if (!target) continue;
      if (statement.exportAll) {
        for (const [name, symbol] of target.exports) {
          if (name !== "default") info.exports.set(name, symbol);
        }
      }
      for (const specifier of statement.specifiers ?? []) {
        const importedName = (specifier.local ?? specifier.exported).name;
        const symbol = target.exports.get(importedName);
        if (!symbol) {
          errors.push(`Native module '${targetPath}' has no export named '${importedName}'`);
        } else {
          info.exports.set(specifier.exported.name, symbol);
        }
      }
    }
  }

  for (const filePath of order) {
    const info = moduleInfos.get(filePath)!;
    const analysis = compileParsedSource(parsedByPath.get(filePath)!).analysis;
    if (!analysis) {
      errors.push(`Unable to analyze native module '${filePath}' for symbol isolation`);
      continue;
    }
    const resolvedSymbols = new Map<Node, Node>(
      analysis.getIdentifierResolutions().map((resolution) => [resolution.identifier, resolution.symbol.node])
    );
    const symbolNames = new Map<Node, string>();
    const typeNames = new Map(info.localSymbols);
    const namespaceExports = new Map<Node, ReadonlyMap<string, string>>();
    for (const statement of info.program.body) {
      for (const identifier of declarationIdentifiers(statement)) {
        const renamed = info.localSymbols.get(identifier.name);
        if (renamed) symbolNames.set(identifier as Node, renamed);
      }
      if (statement.kind !== "ImportStatement") continue;
      const imported = statement as ImportStatement;
      const targetPath = info.importTargets.get(imported);
      const target = targetPath ? moduleInfos.get(targetPath) : undefined;
      if (!target) continue;
      if (imported.defaultImport) {
        const renamed = target.exports.get("default");
        if (!renamed) errors.push(`Native module '${targetPath}' has no default export`);
        else {
          symbolNames.set(imported.defaultImport as Node, renamed);
          typeNames.set(imported.defaultImport.name, renamed);
        }
      }
      if (imported.namespaceImport) {
        namespaceExports.set(imported.namespaceImport as Node, target.exports);
        for (const [exportedName, renamed] of target.exports) {
          typeNames.set(`${imported.namespaceImport.name}.${exportedName}`, renamed);
        }
      }
      for (const specifier of imported.specifiers) {
        const local = specifier.local ?? specifier.imported;
        const renamed = target.exports.get(specifier.imported.name);
        if (!renamed) {
          errors.push(`Native module '${targetPath}' has no export named '${specifier.imported.name}'`);
          continue;
        }
        symbolNames.set(local as Node, renamed);
        typeNames.set(local.name, renamed);
      }
    }

    rewriteNamespaceMembers(info.program, resolvedSymbols, namespaceExports);
    for (const [identifierNode, symbolNode] of resolvedSymbols) {
      const renamed = symbolNames.get(symbolNode);
      if (renamed && identifierNode.kind === "Identifier") {
        (identifierNode as Identifier).name = typeNameWithRenamedBase(
          (identifierNode as Identifier).name,
          typeNames
        );
      }
    }
    for (const [symbolNode, renamed] of symbolNames) {
      if (symbolNode.kind === "Identifier") (symbolNode as Identifier).name = renamed;
    }
    rewriteTypeNames(info.program, typeNames);
  }
  if (errors.length > 0) {
    return { code: "", warnings: [], errors, diagnostics: [], watchedFiles: order };
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
    typeCheck: options.typeCheck ?? true,
    ambientDeclarations: options.ambientDeclarations ?? [],
    ...(options.jsxFactory ? { jsxFactory: options.jsxFactory } : {}),
    ...(options.jsxFragmentFactory ? { jsxFragmentFactory: options.jsxFragmentFactory } : {}),
  });
  return { ...result, watchedFiles: order };
}
