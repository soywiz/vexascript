import { ArrowFunctionExpression, BlockStatement, CatchClause, ClassMethodMember, ClassStatement, ExportStatement, ExprStatement, ForStatement, FunctionExpression, FunctionStatement, Identifier, ImportStatement, MemberExpression, Node, nodeStartOffset, ObjectProperty, Program, PropertyReferenceExpression, VarStatement } from "compiler/ast/ast";
import type { FunctionParameter, Statement } from "compiler/ast/ast";

import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { appendChildNodes, childNodes, unwrapExportedDeclaration } from "compiler/ast/traversal";
import type { AnalysisProfileEvent } from "compiler/analysis/Analysis";
import { substituteTypeNameText } from "compiler/analysis/typeNames";
import { compileParsedSource } from "compiler/pipeline/compile";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import type { ParseIssue } from "compiler/parser/parser";
import { parseSource, type ParseArtifacts } from "compiler/pipeline/parse";
import { vfs, type Vfs } from "compiler/vfs";
import { extname, resolve } from "compiler/utils/path";
import { monotonicNow } from "compiler/utils/time";
import { localImportSpecifiers, parserOptionsForModulePath, type LocalImportDependency } from "./localModuleResolution";
import type { ModuleGraphOptions } from "./moduleGraphModel";
import { transpile, type TranspileResult, type TranspileTarget } from "./transpile";
import { cppBindingMetadata } from "./cppAnnotations";

export interface NativeModuleGraphResult extends TranspileResult {
  watchedFiles: string[];
  nativeCompilerFlags: string[];
}

function formatNativeParseIssue(filePath: string, issue: ParseIssue): string {
  const start = issue.token?.range.start;
  return `${filePath}${start ? `:${start.line + 1}:${start.column + 1}` : ""}: ${issue.message}`;
}

function nativeModuleStatements(program: Program): Statement[] {
  return program.body.flatMap((statement) => {
    if (statement instanceof ImportStatement) return [];
    if (statement instanceof ExportStatement) {
      const exported = statement as ExportStatement;
      if (exported.isDefault && exported.declaration instanceof ExprStatement) return [];
    }
    const declaration = unwrapExportedDeclaration(statement);
    if (declaration && declaration !== statement && statement.annotations?.length) {
      declaration.annotations = [
        ...statement.annotations,
        ...(declaration.annotations ?? []),
      ];
    }
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

interface NativeReexportDependency {
  statement: ExportStatement;
  targetPath: string;
}

function isTypeOnlyImport(statement: ImportStatement): boolean {
  return statement.typeOnly === true || (
    !statement.defaultImport &&
    !statement.namespaceImport &&
    statement.specifiers.length > 0 &&
    statement.specifiers.every((specifier) => specifier.typeOnly === true)
  );
}

function markNativeSourcePath(node: Node, path: string): void {
  node.__vexaNativeSourcePath = path;
  for (const child of childNodes(node)) markNativeSourcePath(child, path);
}

function declarationIdentifiers(statement: Statement): Identifier[] {
  const declaration = unwrapExportedDeclaration(statement);
  if (!declaration) return [];
  if (declaration instanceof VarStatement) {
    return bindingIdentifiers((declaration as VarStatement).name);
  }
  const name = (declaration as { name?: Identifier }).name;
  return name instanceof Identifier ? [name] : [];
}

function nativeSymbolName(moduleIndex: number, sourceName: string): string {
  return `__vexa_module_${moduleIndex}_${sourceName}`;
}

class NativeShadowBinding {
  constructor(public name: string, public declaredOffset: number) {
  }
}

function appendNativeBinding(
  bindings: NativeShadowBinding[],
  name: VarStatement["name"],
  declaredOffset = -1
): void {
  for (const identifier of bindingIdentifiers(name)) {
    bindings.push(new NativeShadowBinding(
      identifier.name,
      declaredOffset >= 0 ? declaredOffset : nodeStartOffset(identifier) ?? -1
    ));
  }
}

function nativeIsolationBindings(node: Node): NativeShadowBinding[] | undefined {
  const createsScope = node instanceof FunctionStatement ||
    node instanceof ArrowFunctionExpression ||
    node instanceof FunctionExpression ||
    node instanceof ClassMethodMember ||
    node instanceof ClassStatement ||
    node instanceof BlockStatement ||
    node instanceof ForStatement ||
    node instanceof CatchClause;
  if (!createsScope) return undefined;
  const bindings: NativeShadowBinding[] = [];
  let parameters: FunctionParameter[] | undefined;
  if (node instanceof FunctionStatement) {
    parameters = node.parameters;
  } else if (node instanceof ArrowFunctionExpression) {
    parameters = node.parameters;
  } else if (node instanceof FunctionExpression) {
    parameters = node.parameters;
  } else if (node instanceof ClassMethodMember) {
    parameters = node.parameters;
  }
  if (parameters) {
    for (const parameter of parameters) appendNativeBinding(bindings, parameter.name, -1);
  }
  if (node instanceof FunctionExpression) {
    const name = (node as FunctionExpression).name;
    if (name) bindings.push(new NativeShadowBinding(name.name, -1));
  }
  if (node instanceof ClassStatement) {
    const classStatement = node as ClassStatement;
    for (const member of classStatement.members) {
      bindings.push(new NativeShadowBinding(member.name.name, -1));
    }
    for (const parameter of classStatement.primaryConstructorParameters ?? []) {
      bindings.push(new NativeShadowBinding(parameter.name.name, -1));
    }
  }
  if (node instanceof BlockStatement) {
    for (const statement of (node as BlockStatement).body) {
      const declaration = unwrapExportedDeclaration(statement);
      if (!declaration) continue;
      if (declaration instanceof VarStatement) {
        const variable = declaration as VarStatement;
        if (variable.declarations?.length) {
          for (const declarator of variable.declarations) {
            appendNativeBinding(bindings, declarator.name, nodeStartOffset(declarator) ?? -1);
          }
        } else {
          appendNativeBinding(bindings, variable.name, nodeStartOffset(variable) ?? -1);
        }
        continue;
      }
      const name = (declaration as unknown as { name?: Identifier }).name;
      if (name) bindings.push(new NativeShadowBinding(name.name, -1));
    }
  }
  if (node instanceof ForStatement) {
    const loop = node as ForStatement;
    if (loop.iterator instanceof VarStatement) {
      appendNativeBinding(bindings, (loop.iterator as VarStatement).name, -1);
    }
    if (loop.initializer instanceof VarStatement) {
      appendNativeBinding(bindings, (loop.initializer as VarStatement).name, -1);
    }
  }
  if (node instanceof CatchClause) {
    const parameter = (node as CatchClause).parameter;
    if (parameter) bindings.push(new NativeShadowBinding(parameter.name, -1));
  }
  return bindings;
}

function isNativeTypeNodeKey(key: string): boolean {
  return key === "typeAnnotation" || key === "returnType" || key === "extendsType" ||
    key === "extendsTypes" || key === "implementsTypes" || key === "targetType" ||
    key === "constraint" || key === "defaultType" || key === "receiverType" ||
    key === "receiverTypeArguments" || key === "typeArguments";
}

function isNativeIdentifierReference(parent: Node, key: string): boolean {
  if (key.length === 0 || isNativeTypeNodeKey(key)) return false;
  if (key === "name" || key === "local" || key === "imported" || key === "exported" ||
      key === "defaultImport" || key === "namespaceImport" || key === "propertyName" ||
      key === "label" || key === "names") return false;
  if (parent instanceof MemberExpression && key === "property") {
    return (parent as MemberExpression).computed;
  }
  if (parent instanceof PropertyReferenceExpression && key === "property") return false;
  if (parent instanceof ObjectProperty && key === "key") {
    return (parent as ObjectProperty).computed === true;
  }
  return true;
}

function isNativeIdentifierShadowed(
  identifier: Identifier,
  shadowScopes: readonly NativeShadowBinding[][]
): boolean {
  const usageOffset: number = identifier.firstToken
    ? Number(identifier.firstToken.range.start.offset)
    : 2_147_483_647;
  for (let index = shadowScopes.length - 1; index >= 0; index -= 1) {
    for (const binding of shadowScopes[index]!) {
      if (binding.name === identifier.name &&
          (binding.declaredOffset < 0 || binding.declaredOffset <= usageOffset)) {
        return true;
      }
    }
  }
  return false;
}

function nativeIdentifierResolutions(
  program: Program,
  targetSymbols: ReadonlyMap<Node, string>,
  typeNames: ReadonlyMap<string, string>,
  additionalTargets: readonly Node[] = []
): Map<Node, Node> {
  const targetsByName = new Map<string, Node>();
  for (const target of targetSymbols.keys()) {
    if (target instanceof Identifier) targetsByName.set(target.name, target);
  }
  for (const target of additionalTargets) {
    if (target instanceof Identifier) targetsByName.set(target.name, target);
  }
  const resolved = new Map<Node, Node>();
  const shadowScopes: NativeShadowBinding[][] = [];
  const pendingNodes: Node[] = [program];
  const pendingParents: Node[] = [program];
  const pendingKeys: string[] = [""];
  const pendingScopeExits: boolean[] = [false];
  const children: Node[] = [];
  const childKeys: string[] = [];
  while (pendingNodes.length > 0) {
    const node = pendingNodes.pop()!;
    const parent = pendingParents.pop()!;
    const key = pendingKeys.pop()!;
    const scopeExit = pendingScopeExits.pop()!;
    if (scopeExit) {
      shadowScopes.pop();
      continue;
    }

    const bindings = nativeIsolationBindings(node);
    if (bindings && bindings.length > 0) {
      shadowScopes.push(bindings);
      pendingNodes.push(node);
      pendingParents.push(parent);
      pendingKeys.push(key);
      pendingScopeExits.push(true);
    }
    if (node instanceof Identifier) {
      if (isNativeTypeNodeKey(key)) {
        node.name = typeNameWithRenamedBase(node.name, typeNames);
      } else if (isNativeIdentifierReference(parent, key) &&
          !isNativeIdentifierShadowed(node, shadowScopes)) {
        const target = targetsByName.get(node.name);
        if (target) resolved.set(node, target);
      }
    }

    children.length = 0;
    childKeys.length = 0;
    appendChildNodes(node, children, childKeys);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pendingNodes.push(children[index]!);
      pendingParents.push(node);
      pendingKeys.push(childKeys[index]!);
      pendingScopeExits.push(false);
    }
  }
  return resolved;
}

function typeNameWithRenamedBase(typeName: string, names: ReadonlyMap<string, string>): string {
  return substituteTypeNameText(typeName, names);
}

function rewriteNamespaceMembers(
  node: Node,
  resolvedSymbols: ReadonlyMap<Node, Node>,
  namespaceExports: ReadonlyMap<Node, ReadonlyMap<string, string>>
): Node {
  if (node instanceof MemberExpression) {
    if (!node.computed && node.object instanceof Identifier && node.property instanceof Identifier) {
      const symbolNode = resolvedSymbols.get(node.object);
      const targetExports: ReadonlyMap<string, string> | undefined = symbolNode
        ? namespaceExports.get(symbolNode)
        : undefined;
      const targetName = targetExports?.get(node.property.name);
      if (targetName) {
        const identifier = new Identifier(targetName);
        if (node.firstToken) identifier.firstToken = node.firstToken;
        if (node.lastToken) identifier.lastToken = node.lastToken;
        if (node.__vexaNativeSourcePath) identifier.__vexaNativeSourcePath = node.__vexaNativeSourcePath;
        return identifier;
      }
    }
  }

  const fields = node as unknown as Record<string, unknown>;
  for (const key in fields) {
    const value = fields[key];
    if (value instanceof Node) {
      fields[key] = rewriteNamespaceMembers(value, resolvedSymbols, namespaceExports);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (let index = 0; index < value.length; index += 1) {
      const element = value[index];
      if (element instanceof Node) {
        value[index] = rewriteNamespaceMembers(element, resolvedSymbols, namespaceExports);
      }
    }
  }
  return node;
}

function moduleInfo(program: Program, path: string, moduleIndex: number): NativeModuleInfo {
  const localSymbols = new Map<string, string>();
  const extensionSymbols = new Map<string, string>();
  for (const statement of program.body) {
    for (const identifier of declarationIdentifiers(statement)) {
      const declaration = unwrapExportedDeclaration(statement);
      if ((declaration instanceof FunctionStatement || declaration instanceof VarStatement) &&
        (declaration as { receiverType?: Identifier }).receiverType) {
        // Extension members are imported by their source-level member name, but
        // native calls are selected from the analyzer's declaration resolution
        // and emitted with a receiver-qualified C++ name. Keep a virtual export
        // here for module validation without introducing a second naming path.
        extensionSymbols.set(identifier.name, `__vexa_extension_import_${moduleIndex}_${identifier.name}`);
        continue;
      }
      identifier.__vexaNativeOriginalName = identifier.name;
      localSymbols.set(identifier.name, nativeSymbolName(moduleIndex, identifier.name));
    }
  }
  const exports = new Map<string, string>([...localSymbols, ...extensionSymbols]);
  for (const statement of program.body) {
    if (!(statement instanceof ExportStatement)) continue;
    const exported = statement as ExportStatement;
    const declarationNames = declarationIdentifiers(statement);
    if (exported.isDefault && declarationNames[0]) {
      exports.set("default", localSymbols.get(declarationNames[0].name)!);
    } else if (exported.isDefault && exported.declaration instanceof ExprStatement) {
      const expression = (exported.declaration as { expression?: Node }).expression;
      if (expression instanceof Identifier) {
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
  const startedAt = monotonicNow();
  let phaseStartedAt = startedAt;
  const reportPhase = (phase: string, moduleCount: number): void => {
    const now = monotonicNow();
    options.profile?.({ phase, elapsedMs: now - phaseStartedAt, moduleCount });
    phaseStartedAt = now;
  };
  const activeVfs: Vfs = options.vfs ?? vfs();
  const importMappings = options.importMappings ?? {};
  const parsedByPath = new Map<string, ParseArtifacts>();
  const sourceByPath = new Map<string, string>();
  const importsByPath = new Map<string, LocalImportDependency[]>();
  const reexportsByPath = new Map<string, NativeReexportDependency[]>();
  const order: string[] = [];
  const visiting = new Set<string>();
  const visitStack: string[] = [];
  const visited = new Set<string>();
  const errors: string[] = [];

  let visit: (filePath: string) => Promise<undefined>;
  visit = async (filePath: string): Promise<undefined> => {
    if (visited.has(filePath) || visiting.has(filePath)) return undefined;
    visiting.add(filePath);
    visitStack.push(filePath);
    const source = await activeVfs.readFile(filePath);
    if (source === null) {
      errors.push(`Unable to read native module '${filePath}'`);
      visiting.delete(filePath);
      return undefined;
    }
    sourceByPath.set(filePath, source);
    const parsedSource = extname(filePath).toLowerCase() === ".json"
      ? `const __vexaJsonDefault = ${source};\nexport default __vexaJsonDefault;`
      : source;
    const parsed = parseSource(parsedSource, extname(filePath).toLowerCase() === ".json"
      ? { language: "typescript" }
      : parserOptionsForModulePath(filePath));
    parsedByPath.set(filePath, parsed);
    for (const issue of parsed.parserIssues) errors.push(formatNativeParseIssue(filePath, issue));
    if (parsed.tokenizeError) errors.push(`${filePath}: ${parsed.tokenizeError.message}`);
    if (parsed.fatalError) errors.push(`${filePath}: ${parsed.fatalError}`);
    if (!parsed.ast) {
      if (parsed.parserIssues.length === 0 && !parsed.tokenizeError && !parsed.fatalError) {
        errors.push(`Unable to parse native module '${filePath}'`);
      }
      visiting.delete(filePath);
      return undefined;
    }
    markNativeSourcePath(parsed.ast, filePath);

    const imports = await localImportSpecifiers(
      parsed.ast,
      filePath,
      activeVfs,
      importMappings,
      options.baseUrl,
      true
    );
    importsByPath.set(filePath, imports);
    const reexports: NativeReexportDependency[] = [];
    for (const statement of parsed.ast.body) {
      if (!(statement instanceof ExportStatement) || !(statement as ExportStatement).from) continue;
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
      if (!(statement instanceof ImportStatement) || resolvedImportStatements.has(statement as ImportStatement)) {
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
          const cyclePaths: string[] = visitStack.slice(Math.max(0, cycleStart));
          cyclePaths.push(dependency.targetPath);
          errors.push(`Native module initialization cycle: ${cyclePaths.join(" -> ")}`);
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
    return undefined;
  };

  await visit(entryFilePath);
  reportPhase("load-and-parse", order.length);
  const entryParsed = parsedByPath.get(entryFilePath);
  const entrySource = sourceByPath.get(entryFilePath) ?? "";
  if (!entryParsed?.ast || errors.length > 0) {
    return { code: "", warnings: [], errors, diagnostics: [], watchedFiles: [...sourceByPath.keys()], nativeCompilerFlags: [] };
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
    const isolationStartedAt = monotonicNow();
    const symbolNames = new Map<Node, string>();
    const typeNames = new Map(info.localSymbols);
    const namespaceExports = new Map<Node, ReadonlyMap<string, string>>();
    for (const statement of info.program.body) {
      for (const identifier of declarationIdentifiers(statement)) {
        const renamed = info.localSymbols.get(identifier.name);
        if (renamed) symbolNames.set(identifier as Node, renamed);
      }
      if (!(statement instanceof ImportStatement)) continue;
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
    const namespaceTargets: Node[] = [];
    for (const target of namespaceExports.keys()) namespaceTargets.push(target);
    const resolvedSymbols = nativeIdentifierResolutions(info.program, symbolNames, typeNames, namespaceTargets);
    options.profile?.({
      phase: "module-isolation-resolution",
      elapsedMs: monotonicNow() - isolationStartedAt,
      moduleCount: order.length,
    });

    if (namespaceExports.size > 0) {
      rewriteNamespaceMembers(info.program, resolvedSymbols, namespaceExports);
    }
    for (const [identifierNode, symbolNode] of resolvedSymbols) {
      const renamed = symbolNames.get(symbolNode);
      if (renamed && identifierNode instanceof Identifier) {
        const identifier = identifierNode as Identifier;
        identifier.__vexaNativeOriginalName ??= identifier.name;
        identifier.name = typeNameWithRenamedBase(
          identifier.name,
          typeNames
        );
      }
    }
    for (const [symbolNode, renamed] of symbolNames) {
      if (symbolNode instanceof Identifier) {
        const identifier = symbolNode as Identifier;
        identifier.__vexaNativeOriginalName ??= identifier.name;
        identifier.name = renamed;
      }
    }
  }
  reportPhase("module-isolation-analysis", order.length);
  if (errors.length > 0) {
    return { code: "", warnings: [], errors, diagnostics: [], watchedFiles: order, nativeCompilerFlags: [] };
  }

  const mergedProgram = new Program(
    order.flatMap((filePath) => nativeModuleStatements(parsedByPath.get(filePath)!.ast!)),
    entryParsed.ast.__vexaRecoveryMarkers
  );
  if (entryParsed.ast.firstToken) mergedProgram.firstToken = entryParsed.ast.firstToken;
  if (entryParsed.ast.lastToken) mergedProgram.lastToken = entryParsed.ast.lastToken;
  if (entryParsed.ast.__vexaNativeSourcePath) {
    mergedProgram.__vexaNativeSourcePath = entryParsed.ast.__vexaNativeSourcePath;
  }
  const reportMergedAnalysis = (event: AnalysisProfileEvent): void => {
    options.profile?.({
      phase: `merged-${event.phase}`,
      elapsedMs: event.elapsedMs,
      moduleCount: order.length,
    });
  };
  const compilationArtifacts = compileParsedSource({ ...entryParsed, ast: mergedProgram }, {
    ambientDeclarations: options.ambientDeclarations ?? [],
    checkTypes: options.typeCheck ?? true,
    inferTypes: options.inferTypes ?? true,
    profile: reportMergedAnalysis,
  });
  reportPhase("merged-analysis", order.length);
  const result = transpile(entrySource, {
    compilationArtifacts,
    sourceFilePath: entryFilePath,
    target,
    emit: "cpp",
    emitNativeSourceLocations: options.emitNativeSourceLocations ?? false,
    emitSourceMap: false,
    typeCheck: options.typeCheck ?? true,
    ambientDeclarations: options.ambientDeclarations ?? [],
    ...(options.jsxFactory ? { jsxFactory: options.jsxFactory } : {}),
    ...(options.jsxFragmentFactory ? { jsxFragmentFactory: options.jsxFragmentFactory } : {}),
  });
  reportPhase("cpp-emission", order.length);
  options.profile?.({
    phase: "total",
    elapsedMs: monotonicNow() - startedAt,
    moduleCount: order.length,
  });
  const nativeResult: NativeModuleGraphResult = {
    code: result.code,
    warnings: result.warnings,
    errors: result.errors,
    diagnostics: result.diagnostics,
    watchedFiles: order,
    nativeCompilerFlags: cppBindingMetadata(mergedProgram).flags,
  };
  if (result.sourceMap !== undefined) nativeResult.sourceMap = result.sourceMap;
  return nativeResult;
}
