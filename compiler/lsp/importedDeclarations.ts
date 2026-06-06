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
    const wantedNames = new Set(
      importStatement.specifiers.map((specifier) => specifier.imported.name)
    );
    if (wantedNames.size === 0) {
      continue;
    }

    const targetFilePath = resolveImportTargetFilePath(currentFilePath, importStatement.from.value);
    if (!targetFilePath) {
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
