import { existsSync, readFileSync } from "node:fs";
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

function resolveLocalModulePath(importerFilePath: string, importPath: string): string | null {
  if (!importPath.startsWith(".")) {
    return null;
  }
  const baseDir = dirname(importerFilePath);
  const direct = resolve(baseDir, importPath);
  if (existsSync(direct) && extname(direct) === ".my") {
    return direct;
  }
  if (!extname(direct)) {
    const withMyExt = `${direct}.my`;
    if (existsSync(withMyExt)) {
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

function localImportSpecifiers(ast: Program, importerFilePath: string): { statement: ImportStatement; targetPath: string }[] {
  const imports: { statement: ImportStatement; targetPath: string }[] = [];
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const targetPath = resolveLocalModulePath(importerFilePath, importStatement.from.value);
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

export function bundleModuleGraph(entryFilePath: string, target: TranspileTarget): TranspileResult {
  const emittedByPath = new Map<string, string>();
  const analysisByPath = new Map<string, Analysis | null>();
  const order: string[] = [];
  const inProgress = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];

  const visit = (filePath: string): void => {
    if (emittedByPath.has(filePath) || inProgress.has(filePath)) {
      return;
    }
    inProgress.add(filePath);

    const source = readFileSync(filePath, "utf8");
    const parsed = parseSource(source);
    const ast = parsed.ast;

    const externalDeclarations: Statement[] = [];
    const importedSymbolTypes = new Map<string, AnalysisType>();
    if (ast) {
      for (const { statement, targetPath } of localImportSpecifiers(ast, filePath)) {
        visit(targetPath);
        const dependencyParsed = parseSource(readFileSync(targetPath, "utf8"));
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

  visit(entryFilePath);

  const code = order
    .map((filePath) => emittedByPath.get(filePath) ?? "")
    .filter((chunk) => chunk.trim().length > 0)
    .join("\n");

  return { code, warnings, errors };
}
