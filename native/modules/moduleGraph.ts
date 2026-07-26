import {
  FunctionStatement,
  Identifier,
  ImportStatement,
  NodeKind,
  VarStatement
} from "../../compiler/ast/ast";
import type { Program, Statement } from "../../compiler/ast/ast";
import type { Analysis } from "../../compiler/analysis/Analysis";
import type { AnalysisType } from "../../compiler/analysis/types";
import { bindingIdentifiers } from "../../compiler/ast/bindingPatterns";
import { unwrapExportedDeclaration } from "../../compiler/ast/traversal";
import { compileParsedSource } from "../../compiler/pipeline/compile";
import { parseSource, type ParseArtifacts } from "../../compiler/pipeline/parse";
import { ensureEcmaScriptRuntimeProgram } from "../../compiler/runtime/ecmascriptDeclarations.shared";
import { collectImplicitVexaExportPlan } from "../../compiler/runtime/implicitExports";
import {
  localImportSpecifiers,
  parserOptionsForModulePath
} from "../../compiler/runtime/localModuleResolution";
import {
  transpile,
  type TranspileResult,
  type TranspileTarget
} from "../../compiler/runtime/transpile";
import type { Vfs } from "../../compiler/vfs";
import { vfs } from "../../compiler/vfs";
import { resolveNodeModuleImportsForRuntime } from "./nodeModuleImportResolution";

const TYPE_DECLARATION_KINDS = new Set<Statement["kind"]>([
  NodeKind.ClassStatement,
  NodeKind.InterfaceStatement,
  NodeKind.EnumStatement,
  NodeKind.TypeAliasStatement
]);

interface NativeModuleGraphOptions {
  ambientDeclarations?: Statement[];
  importMappings?: Readonly<Record<string, string>>;
  baseUrl?: string;
  typeCheck?: boolean;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
}

export class ModuleGraphSourcesResult {
  constructor(
    public entrySource: string,
    public moduleSources: Map<string, string>,
    public warnings: string[],
    public errors: string[],
    public diagnostics: TranspileResult["diagnostics"],
    public watchedFiles: string[]
  ) {}
}

interface NativeModuleGraphContext {
  target: TranspileTarget;
  options: NativeModuleGraphOptions;
  activeVfs: Vfs;
  moduleSources: Map<string, string>;
  parsedByPath: Map<string, ParseArtifacts>;
  analysisByPath: Map<string, Analysis | null>;
  inProgress: Set<string>;
  watchedFiles: Set<string>;
  warnings: string[];
  errors: string[];
  diagnostics: TranspileResult["diagnostics"];
}

function stringSetValues(values: Set<string>): string[] {
  const result: string[] = [];
  for (const value of values) {
    result.push(value);
  }
  return result;
}

function declarationName(statement: Statement): string | null {
  if (statement instanceof VarStatement && statement.receiverType) {
    return bindingIdentifiers(statement.name)[0]?.name ?? null;
  }
  if (statement instanceof FunctionStatement && statement.receiverType && statement.operator) {
    return statement.name.name;
  }
  const candidate = unwrapExportedDeclaration(statement);
  if (!candidate) {
    return null;
  }
  if (!TYPE_DECLARATION_KINDS.has(candidate.kind)
      && !(candidate instanceof FunctionStatement)
      && !(candidate instanceof VarStatement)) {
    return null;
  }
  const named = candidate as { name?: Identifier };
  return named.name instanceof Identifier ? named.name.name : null;
}

function collectImportedDeclarations(
  dependencyAst: Program,
  importedNames: Set<string>
): Statement[] {
  const declarations: Statement[] = [];
  for (const statement of dependencyAst.body) {
    const declaration = unwrapExportedDeclaration(statement) ?? statement;
    const name = declarationName(statement);
    if (TYPE_DECLARATION_KINDS.has(declaration.kind)
        || (name !== null && importedNames.has(name))) {
      declarations.push(declaration);
    }
  }
  return declarations;
}

function appendImplicitCommonJsExports(
  code: string,
  ast: Program,
  filePath: string
): string {
  const plan = collectImplicitVexaExportPlan(ast, filePath);
  if (plan.commonJsLines.length === 0) {
    return code;
  }
  const exports = plan.commonJsLines.join("\n");
  return code.trim().length > 0 ? `${code}\n${exports}` : exports;
}

function completeVisitedModule(
  filePath: string,
  ast: Program,
  result: TranspileResult,
  context: NativeModuleGraphContext
): string {
  context.errors.push(...result.errors);
  context.warnings.push(...result.warnings);
  context.diagnostics.push(...result.diagnostics);
  const emittedSource = appendImplicitCommonJsExports(result.code, ast, filePath);
  context.moduleSources.set(filePath, emittedSource);
  context.inProgress.delete(filePath);
  return emittedSource;
}

async function visitModule(
  filePath: string,
  context: NativeModuleGraphContext
): Promise<string> {
  if (context.moduleSources.has(filePath) || context.inProgress.has(filePath)) {
    return "";
  }
  context.inProgress.add(filePath);
  context.watchedFiles.add(filePath);
  const source = await context.activeVfs.readFile(filePath);
  if (source === null) {
    context.errors.push(`Unable to read module '${filePath}'`);
    context.inProgress.delete(filePath);
    return "";
  }
  const parserOptions = parserOptionsForModulePath(filePath);
  const parsed = parseSource(source, parserOptions);
  context.parsedByPath.set(filePath, parsed);
  if (!parsed.ast) {
    context.errors.push(`Unable to parse module '${filePath}'`);
    context.inProgress.delete(filePath);
    return "";
  }
  const ast = parsed.ast;
  const importMappings = context.options.importMappings ?? {};
  const localImports = await localImportSpecifiers(
    ast,
    filePath,
    context.activeVfs,
    importMappings,
    context.options.baseUrl
  );
  for (const dependency of localImports) {
    await visitModule(dependency.targetPath, context);
  }

  const imported = await resolveNodeModuleImportsForRuntime(
    ast,
    filePath,
    context.activeVfs
  );
  const externalDeclarations = imported.externalDeclarations;
  const importedSymbols = imported.importedSymbols;
  for (const dependency of localImports) {
    const dependencyParsed = context.parsedByPath.get(dependency.targetPath);
    if (dependencyParsed?.ast) {
      const importedNames = new Set<string>();
      for (const specifier of dependency.statement.specifiers) {
        importedNames.add(specifier.imported.name);
      }
      externalDeclarations.push(
        ...collectImportedDeclarations(dependencyParsed.ast, importedNames)
      );
    }
    const dependencyAnalysis = context.analysisByPath.get(dependency.targetPath);
    if (dependencyAnalysis) {
      for (const specifier of dependency.statement.specifiers) {
        const importedType = dependencyAnalysis.getTopLevelSymbolType(
          specifier.imported.name
        );
        if (importedType) {
          const localName = (specifier.local ?? specifier.imported).name;
          importedSymbols.set(localName, { type: importedType });
        }
      }
    }
  }

  const ambientDeclarations = context.options.ambientDeclarations ?? [];
  const compilationArtifacts = compileParsedSource(parsed, {
    externalDeclarations,
    ambientDeclarations,
    importedSymbols
  });
  context.analysisByPath.set(filePath, compilationArtifacts.analysis);
  const result = transpile(source, {
    compilationArtifacts,
    sourceFilePath: filePath,
    target: context.target,
    emitSourceMap: false,
    moduleFormat: "commonjs",
    parserOptions,
    externalDeclarations,
    importedSymbols,
    ambientDeclarations,
    typeCheck: context.options.typeCheck ?? true,
    ...(context.options.jsxFactory
      ? { jsxFactory: context.options.jsxFactory }
      : {}),
    ...(context.options.jsxFragmentFactory
      ? { jsxFragmentFactory: context.options.jsxFragmentFactory }
      : {})
  });
  return completeVisitedModule(filePath, ast, result, context);
}

export async function bundleModuleGraphAsModules(
  entryFilePath: string,
  target: TranspileTarget,
  options: NativeModuleGraphOptions = {}
): Promise<ModuleGraphSourcesResult> {
  await ensureEcmaScriptRuntimeProgram();
  const context: NativeModuleGraphContext = {
    target,
    options,
    activeVfs: vfs(),
    moduleSources: new Map(),
    parsedByPath: new Map(),
    analysisByPath: new Map(),
    inProgress: new Set(),
    watchedFiles: new Set(),
    warnings: [],
    errors: [],
    diagnostics: []
  };
  const entrySource = await visitModule(entryFilePath, context);
  return new ModuleGraphSourcesResult(
    entrySource,
    context.moduleSources,
    context.warnings,
    context.errors,
    context.diagnostics,
    stringSetValues(context.watchedFiles)
  );
}
