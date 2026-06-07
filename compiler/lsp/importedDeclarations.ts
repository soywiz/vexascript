import type {
  ClassStatement,
  EnumStatement,
  FunctionStatement,
  ImportStatement,
  InterfaceStatement,
  Program,
  Statement,
  TypeAliasStatement
} from "compiler/ast/ast";
import { getProjectSessionForFilePath, type ProjectContext } from "./projectAnalysis";
import { uriToFilePath } from "./importFixes";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import { topLevelDeclarationNames } from "./declarationResolver";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import type { AnalysisType } from "compiler/analysis/types";
import { namedType } from "compiler/analysis/types";
import { getNodeModuleTypings } from "./nodeModulesTypings";

/**
 * Top-level declarations that contribute a named type and whose members the
 * single-file analysis may need to resolve across files (e.g. the receiver of an
 * extension method declared on an imported class).
 */
const TYPE_DECLARATION_KINDS = new Set<Statement["kind"]>([
  "ClassStatement",
  "InterfaceStatement",
  "EnumStatement",
  "TypeAliasStatement"
]);

type NamedTypeDeclaration =
  | ClassStatement
  | InterfaceStatement
  | EnumStatement
  | TypeAliasStatement;

type ImportableDeclaration = NamedTypeDeclaration | FunctionStatement;

export interface CollectImportedDeclarationsContext extends ProjectContext {
  uri?: string;
}

function unwrapDeclaration(statement: Statement): ImportableDeclaration | null {
  const candidate = unwrapExportedDeclaration(statement);
  if (!candidate) {
    return null;
  }
  if (TYPE_DECLARATION_KINDS.has(candidate.kind)) {
    return candidate as NamedTypeDeclaration;
  }
  // Extension operator overloads (e.g. `fun Point.operator+`) can be imported by
  // their synthesized name (`operator+`) so the operator resolves cross-file.
  if (candidate.kind === "FunctionStatement") {
    const functionStatement = candidate as FunctionStatement;
    if (functionStatement.receiverType && functionStatement.operator) {
      return functionStatement;
    }
  }
  return null;
}

/**
 * Collect the imported top-level type declarations referenced by a document's
 * `import { ... } from "..."` statements. The returned statements come from the
 * imported files' parsed programs and are intended to be passed to `Analysis`
 * as `externalDeclarations` so cross-file receivers/members resolve.
 *
 * Aliased imports (`import { Point as P }`) are not remapped: the declaration is
 * still registered under its original name, which matches direct imports — the
 * common case for extension methods.
 */
export function collectImportedTypeDeclarations(
  ast: Program,
  context: CollectImportedDeclarationsContext
): Statement[] {
  const currentFilePath = context.uri ? uriToFilePath(context.uri) : null;
  if (!currentFilePath) {
    return [];
  }

  const result: Statement[] = [];
  const seen = new Set<ImportableDeclaration>();

  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const targetFilePath = resolveImportTargetFilePath(currentFilePath, importStatement.from.value);
    if (!targetFilePath) {
      // Bare specifier — load all declarations from node_modules typings so
      // named types (namespaces, interfaces) resolve for member access.
      const nodeModuleTypings = getNodeModuleTypings(currentFilePath, importStatement.from.value);
      if (nodeModuleTypings) {
        for (const targetStatement of nodeModuleTypings.declarations) {
          // For node_modules .d.ts files, include all top-level declarations
          // (namespaces, functions, interfaces, classes) without filtering so
          // member resolution works for named types like `moment.parseZone`.
          if (!seen.has(targetStatement as ImportableDeclaration)) {
            seen.add(targetStatement as ImportableDeclaration);
            result.push(targetStatement);
          }
        }
      }
      continue;
    }

    const wantedNames = new Set(
      importStatement.specifiers.map((specifier) => specifier.imported.name)
    );
    if (wantedNames.size === 0) {
      continue;
    }
    const targetSession = getProjectSessionForFilePath(targetFilePath, context);
    if (!targetSession?.ast) {
      continue;
    }

    for (const targetStatement of targetSession.ast.body) {
      const declaration = unwrapDeclaration(targetStatement);
      if (!declaration || seen.has(declaration)) {
        continue;
      }
      if (!topLevelDeclarationNames(declaration).some((name) => wantedNames.has(name))) {
        continue;
      }
      seen.add(declaration);
      result.push(declaration);
    }
  }

  return result;
}

/**
 * Resolves the types of values imported by a document's `import { ... } from "..."`
 * statements, keyed by the local name they are bound to. The type is taken from
 * the imported file's own analysis, so it reflects inferred return types (e.g. a
 * function whose body returns a `Promise`). Intended to be passed to `Analysis`
 * as `importedSymbolTypes` so cross-file calls resolve their value type and
 * participate in pervasive auto-await.
 */
export function collectImportedSymbolTypes(
  ast: Program,
  context: CollectImportedDeclarationsContext
): Map<string, AnalysisType> {
  const result = new Map<string, AnalysisType>();
  const currentFilePath = context.uri ? uriToFilePath(context.uri) : null;
  if (!currentFilePath) {
    return result;
  }

  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const targetFilePath = resolveImportTargetFilePath(currentFilePath, importStatement.from.value);
    if (!targetFilePath) {
      // Bare specifier — assign a named type from node_modules typings so that
      // default/namespace/named imports resolve their members in hover/completion.
      const nodeModuleTypings = getNodeModuleTypings(currentFilePath, importStatement.from.value);
      if (nodeModuleTypings?.defaultExportName) {
        const exportType = namedType(nodeModuleTypings.defaultExportName);
        if (importStatement.defaultImport) {
          result.set(importStatement.defaultImport.name, exportType);
        }
        if (importStatement.namespaceImport) {
          result.set(importStatement.namespaceImport.name, exportType);
        }
        for (const specifier of importStatement.specifiers) {
          const localName = (specifier.local ?? specifier.imported).name;
          result.set(localName, exportType);
        }
      }
      continue;
    }
    if (importStatement.specifiers.length === 0) {
      continue;
    }
    const targetSession = getProjectSessionForFilePath(targetFilePath, context);
    const targetAnalysis = targetSession?.analysis;
    if (!targetAnalysis) {
      continue;
    }
    for (const specifier of importStatement.specifiers) {
      const localName = (specifier.local ?? specifier.imported).name;
      const importedType = targetAnalysis.getTopLevelSymbolType(specifier.imported.name);
      if (importedType) {
        result.set(localName, importedType);
      }
    }
  }

  return result;
}
