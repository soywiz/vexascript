import { access, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import type {
  Identifier,
  ImportStatement,
  Program,
  Statement
} from "compiler/ast/ast";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { parseSource } from "compiler/pipeline/parse";
import { compileSource } from "compiler/pipeline/compile";
import type { Analysis } from "compiler/analysis/Analysis";
import type { AnalysisType } from "compiler/analysis/types";
import { namedType } from "compiler/analysis/types";
import { resolveNodeModulesTypingsPath } from "compiler/moduleResolution";
import { ensureEcmaScriptRuntimeProgram } from "./ecmascriptDeclarations";
import { transpile, type TranspileResult, type TranspileTarget } from "./transpile";

/**
 * Resolves a project's local module graph and bundles it into a single
 * executable JavaScript module.
 *
 * MyLang local files (`./foo`, `../bar`) do not produce real ES module exports,
 * so cross-file references cannot be resolved at runtime through the normal
 * module loader. For `run`, the entry file and every local `.my` module it
 * imports (transitively) are transpiled and concatenated in dependency order
 * into one module, with the now-internal local `import` statements removed.
 *
 * Each module is transpiled with the declarations imported from its local
 * dependencies provided as `externalDeclarations`, so the analyzer and emitter
 * resolve cross-file classes, operator overloads and extension properties.
 */

async function resolveLocalModulePath(importerFilePath: string, importPath: string): Promise<string | null> {
  if (!importPath.startsWith(".")) {
    return null;
  }
  const baseDir = dirname(importerFilePath);
  const direct = resolve(baseDir, importPath);
  const directExists = await access(direct).then(() => true).catch(() => false);
  if (directExists && extname(direct) === ".my") {
    return direct;
  }
  if (!extname(direct)) {
    const withMyExt = `${direct}.my`;
    const withExtExists = await access(withMyExt).then(() => true).catch(() => false);
    if (withExtExists) {
      return withMyExt;
    }
  }
  return null;
}

function declarationName(statement: Statement): string | null {
  const candidate = unwrapExportedDeclaration(statement);
  if (!candidate) {
    return null;
  }
  const named = candidate as { name?: { kind?: string; name?: string } };
  if (named.name && named.name.kind === "Identifier") {
    return (named.name as Identifier).name;
  }
  return null;
}

/**
 * Collects the top-level declarations of `dependencyAst` whose name matches one
 * of `importedNames`. Returned declarations are intended to be passed to
 * `transpile` as `externalDeclarations` for the importing module.
 */
function collectImportedDeclarations(dependencyAst: Program, importedNames: Set<string>): Statement[] {
  const result: Statement[] = [];
  for (const statement of dependencyAst.body) {
    const name = declarationName(statement);
    if (!name || !importedNames.has(name)) {
      continue;
    }
    const declaration = unwrapExportedDeclaration(statement);
    if (declaration) {
      result.push(declaration);
    }
  }
  return result;
}

/**
 * Detects `export = X` in a .d.ts AST (represented as a bare ExprStatement
 * with an Identifier) and returns the exported name, mirroring the LSP logic.
 */
function detectDtsDefaultExportName(ast: Program): string | null {
  for (const stmt of ast.body) {
    if (stmt.kind === "ExprStatement") {
      const expr = (stmt as { expression?: { kind?: string; name?: string } }).expression;
      if (expr?.kind === "Identifier" && expr.name) return expr.name;
    }
  }
  // Fall back to first top-level namespace that shares a name with a top-level
  // function — the common dual function+namespace pattern (e.g. moment).
  const functionNames = new Set<string>();
  for (const stmt of ast.body) {
    if (stmt.kind === "FunctionStatement") {
      const name = (stmt as { name?: { name?: string } }).name?.name;
      if (name) functionNames.add(name);
    }
  }
  for (const stmt of ast.body) {
    if (stmt.kind === "NamespaceStatement") {
      const name = (stmt as { names?: { name: string }[] }).names?.[0]?.name;
      if (name && functionNames.has(name)) return name;
    }
  }
  return null;
}

/**
 * Loads the .d.ts typings for every bare-specifier import in `ast` and merges
 * their declarations into `externalDeclarations` and their default-export types
 * into `importedSymbolTypes`. This gives the CLI type-checker the same npm
 * package information the LSP already has.
 */
async function collectNodeModulesTypings(
  ast: Program,
  importerFilePath: string,
  externalDeclarations: Statement[],
  importedSymbolTypes: Map<string, AnalysisType>
): Promise<void> {
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") continue;
    const importStatement = statement as ImportStatement;
    const specifier = importStatement.from.value;
    if (specifier.startsWith(".") || specifier.startsWith("/")) continue;

    const typingsPath = await resolveNodeModulesTypingsPath(importerFilePath, specifier);
    if (!typingsPath) continue;
    const exists = await access(typingsPath).then(() => true).catch(() => false);
    if (!exists) continue;

    const source = await readFile(typingsPath, "utf8");
    const parsed = parseSource(source, { language: "typescript" });
    if (!parsed.ast) continue;

    // All top-level declarations become externalDeclarations so the type
    // checker can resolve named types (interfaces, namespaces, etc.).
    for (const decl of parsed.ast.body) {
      externalDeclarations.push(decl);
    }

    // Assign a named type to default / namespace / named imports so member
    // access (e.g. moment.parseZone(...).format(1)) resolves properly.
    const defaultExportName = detectDtsDefaultExportName(parsed.ast) ?? specifier;
    const exportType = namedType(defaultExportName);
    if (importStatement.defaultImport) {
      importedSymbolTypes.set(importStatement.defaultImport.name, exportType);
    }
    if (importStatement.namespaceImport) {
      importedSymbolTypes.set(importStatement.namespaceImport.name, exportType);
    }
    for (const s of importStatement.specifiers) {
      const localName = (s.local ?? s.imported).name;
      importedSymbolTypes.set(localName, exportType);
    }
  }
}

async function localImportSpecifiers(ast: Program, importerFilePath: string): Promise<{ statement: ImportStatement; targetPath: string }[]> {
  const imports: { statement: ImportStatement; targetPath: string }[] = [];
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const targetPath = await resolveLocalModulePath(importerFilePath, importStatement.from.value);
    if (targetPath) {
      imports.push({ statement: importStatement, targetPath });
    }
  }
  return imports;
}

/**
 * Removes the emitted `import ... from "<local>"` / `import "<local>"`
 * statements that reference bundled local modules. Every local relative import
 * is inlined, so any emitted relative import is dropped.
 */
function stripBundledImports(code: string): string {
  return code
    .split("\n")
    .filter((line) => {
      const match = /^\s*import\b.*?["']([^"']+)["']\s*;?\s*$/.exec(line);
      if (!match) {
        return true;
      }
      const specifier = match[1] ?? "";
      return !specifier.startsWith(".");
    })
    .join("\n");
}

export async function bundleModuleGraph(entryFilePath: string, target: TranspileTarget): Promise<TranspileResult> {
  await ensureEcmaScriptRuntimeProgram();

  const emittedByPath = new Map<string, string>();
  const analysisByPath = new Map<string, Analysis | null>();
  const order: string[] = [];
  const inProgress = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];

  const visit = async (filePath: string): Promise<void> => {
    if (emittedByPath.has(filePath) || inProgress.has(filePath)) {
      return;
    }
    inProgress.add(filePath);

    const source = await readFile(filePath, "utf8");
    const parsed = parseSource(source);
    const ast = parsed.ast;

    const externalDeclarations: Statement[] = [];
    const importedSymbolTypes = new Map<string, AnalysisType>();
    if (ast) {
      await collectNodeModulesTypings(ast, filePath, externalDeclarations, importedSymbolTypes);
      for (const { statement, targetPath } of await localImportSpecifiers(ast, filePath)) {
        await visit(targetPath);
        const dependencyParsed = parseSource(await readFile(targetPath, "utf8"));
        if (dependencyParsed.ast) {
          const importedNames = new Set(
            statement.specifiers.map((specifier) => specifier.imported.name)
          );
          externalDeclarations.push(...collectImportedDeclarations(dependencyParsed.ast, importedNames));
        }
        // Resolve imported value types (e.g. functions returning a Promise) from
        // the dependency's analysis so cross-file calls participate in auto-await.
        const dependencyAnalysis = analysisByPath.get(targetPath);
        if (dependencyAnalysis) {
          for (const specifier of statement.specifiers) {
            const importedType = dependencyAnalysis.getTopLevelSymbolType(specifier.imported.name);
            if (importedType) {
              importedSymbolTypes.set((specifier.local ?? specifier.imported).name, importedType);
            }
          }
        }
      }
    }

    // Store this module's analysis (resolved with its own cross-file types) so
    // modules that import from it can read their imported value types.
    analysisByPath.set(
      filePath,
      compileSource(source, {}, { externalDeclarations, importedSymbolTypes }).analysis
    );

    const result = transpile(source, {
      sourceFilePath: filePath,
      target,
      externalDeclarations,
      importedSymbolTypes
    });
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    emittedByPath.set(filePath, stripBundledImports(result.code));

    inProgress.delete(filePath);
    order.push(filePath);
  };

  await visit(entryFilePath);

  const code = order
    .map((filePath) => emittedByPath.get(filePath) ?? "")
    .filter((chunk) => chunk.trim().length > 0)
    .join("\n");

  return { code, warnings, errors, diagnostics: [] };
}
