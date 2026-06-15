import type {
  ClassStatement,
  EnumStatement,
  ExprStatement,
  FunctionStatement,
  Identifier,
  ImportStatement,
  InterfaceMember,
  InterfaceMethodMember,
  InterfaceStatement,
  NamespaceStatement,
  Program,
  Statement,
  TypeAliasStatement,
  VarStatement
} from "compiler/ast/ast";
import { getProjectSessionForFilePath, type ProjectContext } from "./projectAnalysis";
import { uriToFilePath } from "./importFixes";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import { topLevelDeclarationNames } from "./declarationResolver";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import type { AnalysisType, ArrayType } from "compiler/analysis/types";
import {
  BUILTIN_TYPE_NAMES,
  arrayType,
  builtinType,
  functionType,
  intersectionType,
  namedType,
  unionType,
  UNKNOWN_TYPE
} from "compiler/analysis/types";
import { parseTypeNameShape, splitTopLevelTypeText, stripEnclosingTypeParens } from "compiler/analysis/typeNames";
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

type ImportableDeclaration = NamedTypeDeclaration | FunctionStatement | VarStatement;

function typeFromAnnotationText(typeName: string | undefined): AnalysisType {
  if (!typeName) {
    return UNKNOWN_TYPE;
  }
  const normalized = stripEnclosingTypeParens(typeName.trim());
  const unionParts = splitTopLevelTypeText(normalized, "|");
  if (unionParts.length > 1) {
    return unionType(unionParts.map((part) => typeFromAnnotationText(part)));
  }
  const intersectionParts = splitTopLevelTypeText(normalized, "&");
  if (intersectionParts.length > 1) {
    return intersectionType(intersectionParts.map((part) => typeFromAnnotationText(part)));
  }
  const parsed = parseTypeNameShape(typeName);
  const resolvedTypeArguments = parsed.typeArguments.map((argument) => typeFromAnnotationText(argument));
  let resolvedBase: AnalysisType = BUILTIN_TYPE_NAMES.has(parsed.baseName)
    ? builtinType(parsed.baseName as Parameters<typeof builtinType>[0])
    : namedType(parsed.baseName, resolvedTypeArguments);
  for (let depth = 0; depth < parsed.arrayDepth; depth += 1) {
    resolvedBase = arrayType(resolvedBase);
  }
  return resolvedBase;
}

function callableTypeFromExternalFunction(declarations: readonly Statement[], name: string): AnalysisType | null {
  for (const statement of declarations) {
    if (statement.kind !== "ExportStatement" || (statement as { default?: boolean }).default !== true) {
      continue;
    }
    const declaration = unwrapExportedDeclaration(statement);
    if (declaration?.kind !== "FunctionStatement") {
      continue;
    }
    const fn = declaration as FunctionStatement;
    if (fn.name.name !== name) {
      continue;
    }
    return functionType(
      fn.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => {
        const rawType = typeFromAnnotationText(parameter.typeAnnotation?.name);
        const isRest = parameter.rest === true;
        const type = isRest && rawType.kind === "array" ? (rawType as ArrayType).elementType : rawType;
        return {
          name: parameter.name.kind === "Identifier" ? parameter.name.name : "arg",
          type,
          optional: parameter.optional === true || parameter.defaultValue !== undefined || isRest,
          rest: isRest
        };
      }),
      typeFromAnnotationText(fn.returnType?.name),
      fn.typeParameters?.map((parameter) => parameter.name.name)
    );
  }
  return null;
}

function buildFunctionTypeFromStatement(fn: FunctionStatement): AnalysisType {
  return functionType(
    fn.parameters
      .filter((p) => p.thisParameter !== true)
      .map((p) => {
        const rawType = typeFromAnnotationText(p.typeAnnotation?.name);
        const isRest = p.rest === true;
        const type = isRest && rawType.kind === "array" ? (rawType as ArrayType).elementType : rawType;
        return {
          name: p.name.kind === "Identifier" ? (p.name as Identifier).name : "arg",
          type,
          optional: p.optional === true || p.defaultValue !== undefined || isRest,
          rest: isRest
        };
      }),
    typeFromAnnotationText(fn.returnType?.name),
    fn.typeParameters?.map((tp) => tp.name.name)
  );
}

function findAmbientImportedTypeReference(
  declarations: readonly Statement[],
  localName: string
): { importPath: string; importedName: string } | null {
  for (const statement of declarations) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    for (const specifier of importStatement.specifiers) {
      const boundName = (specifier.local ?? specifier.imported).name;
      if (boundName === localName) {
        return {
          importPath: importStatement.from.value,
          importedName: specifier.imported.name
        };
      }
    }
  }
  return null;
}

function findAmbientTypeAliasStatement(
  declarations: readonly Statement[],
  typeName: string
): TypeAliasStatement | null {
  for (const statement of declarations) {
    const declaration = statement.kind === "ExportStatement"
      ? (statement as { declaration?: Statement }).declaration ?? statement
      : statement;
    if (declaration.kind === "TypeAliasStatement" && (declaration as TypeAliasStatement).name.name === typeName) {
      return declaration as TypeAliasStatement;
    }
  }
  return null;
}

function hasAmbientNamedTypeDeclaration(
  declarations: readonly Statement[],
  typeName: string
): boolean {
  for (const statement of declarations) {
    const declaration = statement.kind === "ExportStatement"
      ? (statement as { declaration?: Statement }).declaration ?? statement
      : statement;
    if (
      (declaration.kind === "ClassStatement" ||
        declaration.kind === "InterfaceStatement" ||
        declaration.kind === "EnumStatement") &&
      (declaration as { name?: { name?: string } }).name?.name === typeName
    ) {
      return true;
    }
  }
  return false;
}

function ambientModuleCandidates(
  moduleName: string,
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>
): readonly Statement[][] {
  const candidates: Statement[][] = [];
  const direct = ambientModuleDeclarations.get(moduleName);
  if (direct) {
    candidates.push(direct);
  }
  if (moduleName.startsWith("node:")) {
    const base = ambientModuleDeclarations.get(moduleName.slice("node:".length));
    if (base) {
      candidates.push(base);
    }
  }
  return candidates;
}

function resolveAmbientTypeReference(
  moduleName: string,
  typeName: string,
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  visited: Set<string>
): AnalysisType | null {
  for (const declarations of ambientModuleCandidates(moduleName, ambientModuleDeclarations)) {
    const local = typeFromAmbientAnnotationText(typeName, declarations, ambientModuleDeclarations, visited);
    if (local.kind !== "named" || local.name !== typeName || (local.typeArguments?.length ?? 0) > 0) {
      return local;
    }
    if (hasAmbientNamedTypeDeclaration(declarations, typeName)) {
      return local;
    }
  }
  return null;
}

function typeFromAmbientAnnotationText(
  typeName: string | undefined,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  visited: Set<string> = new Set()
): AnalysisType {
  if (!typeName) {
    return UNKNOWN_TYPE;
  }
  const normalized = stripEnclosingTypeParens(typeName.trim());
  const unionParts = splitTopLevelTypeText(normalized, "|");
  if (unionParts.length > 1) {
    return unionType(unionParts.map((part) =>
      typeFromAmbientAnnotationText(part, declarations, ambientModuleDeclarations, visited)
    ));
  }
  const intersectionParts = splitTopLevelTypeText(normalized, "&");
  if (intersectionParts.length > 1) {
    return intersectionType(intersectionParts.map((part) =>
      typeFromAmbientAnnotationText(part, declarations, ambientModuleDeclarations, visited)
    ));
  }

  const parsed = parseTypeNameShape(normalized);
  const resolvedTypeArguments = parsed.typeArguments.map((argument) =>
    typeFromAmbientAnnotationText(argument, declarations, ambientModuleDeclarations, visited)
  );
  let resolvedBase: AnalysisType;

  if (BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
    resolvedBase = builtinType(parsed.baseName as Parameters<typeof builtinType>[0]);
  } else {
    const visitKey = parsed.baseName;
    const typeAlias = findAmbientTypeAliasStatement(declarations, parsed.baseName);
    if (typeAlias && !visited.has(visitKey)) {
      visited.add(visitKey);
      resolvedBase = typeFromAmbientAnnotationText(typeAlias.targetType.name, declarations, ambientModuleDeclarations, visited);
      visited.delete(visitKey);
    } else {
      const importedReference = findAmbientImportedTypeReference(declarations, parsed.baseName);
      if (importedReference) {
        resolvedBase = resolveAmbientTypeReference(
          importedReference.importPath,
          importedReference.importedName,
          ambientModuleDeclarations,
          visited
        ) ?? namedType(parsed.baseName, resolvedTypeArguments);
      } else {
        resolvedBase = namedType(parsed.baseName, resolvedTypeArguments);
      }
    }
  }

  let resolved: AnalysisType = resolvedBase.kind === "named" && resolvedTypeArguments.length > 0
    ? namedType(resolvedBase.name, resolvedTypeArguments)
    : resolvedBase;
  for (let depth = 0; depth < parsed.arrayDepth; depth += 1) {
    resolved = arrayType(resolved);
  }
  return resolved;
}

function buildAmbientFunctionTypeFromStatement(
  fn: FunctionStatement,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>
): AnalysisType {
  return functionType(
    fn.parameters
      .filter((p) => p.thisParameter !== true)
      .map((p) => {
        const rawType = typeFromAmbientAnnotationText(p.typeAnnotation?.name, declarations, ambientModuleDeclarations);
        const isRest = p.rest === true;
        const type = isRest && rawType.kind === "array" ? (rawType as ArrayType).elementType : rawType;
        return {
          name: p.name.kind === "Identifier" ? (p.name as Identifier).name : "arg",
          type,
          optional: p.optional === true || p.defaultValue !== undefined || isRest,
          rest: isRest
        };
      }),
    typeFromAmbientAnnotationText(fn.returnType?.name, declarations, ambientModuleDeclarations),
    fn.typeParameters?.map((tp) => tp.name.name)
  );
}

function buildAmbientFunctionTypeFromInterfaceMember(
  member: InterfaceMethodMember,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>
): AnalysisType {
  return functionType(
    member.parameters
      .filter((p) => p.thisParameter !== true)
      .map((p) => {
        const rawType = typeFromAmbientAnnotationText(p.typeAnnotation?.name, declarations, ambientModuleDeclarations);
        const isRest = p.rest === true;
        const type = isRest && rawType.kind === "array" ? (rawType as ArrayType).elementType : rawType;
        return {
          name: p.name.kind === "Identifier" ? (p.name as Identifier).name : "arg",
          type,
          optional: p.optional === true || p.defaultValue !== undefined || isRest,
          rest: isRest
        };
      }),
    typeFromAmbientAnnotationText(member.returnType?.name, declarations, ambientModuleDeclarations)
  );
}

function typeFromAmbientInterfaceMember(
  member: InterfaceMember,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>
): AnalysisType {
  if (member.kind === "InterfaceMethodMember") {
    return buildAmbientFunctionTypeFromInterfaceMember(member as InterfaceMethodMember, declarations, ambientModuleDeclarations);
  }
  return typeFromAmbientAnnotationText(member.typeAnnotation?.name, declarations, ambientModuleDeclarations);
}

function detectExportEqualsNameInDecls(stmts: Statement[]): string | null {
  for (const stmt of stmts) {
    if (stmt.kind === "ExprStatement") {
      const expr = (stmt as ExprStatement).expression;
      if (expr?.kind === "Identifier") return (expr as Identifier).name;
    }
  }
  return null;
}

function findNamespaceBodyInStmts(stmts: Statement[], namespaceName: string): Statement[] | null {
  for (const stmt of stmts) {
    if (stmt.kind === "NamespaceStatement") {
      const ns = stmt as NamespaceStatement;
      if (ns.names?.[0]?.name === namespaceName) {
        return ns.body?.body ?? null;
      }
    }
  }
  return null;
}

function extractDirectTypeForName(stmts: Statement[], symbolName: string): AnalysisType | null {
  for (const stmt of stmts) {
    const decl =
      stmt.kind === "ExportStatement"
        ? (stmt as { declaration?: Statement }).declaration ?? stmt
        : stmt;

    if (decl.kind === "FunctionStatement") {
      const fn = decl as FunctionStatement;
      if (fn.name?.name === symbolName) {
        return buildFunctionTypeFromStatement(fn);
      }
    }

    if (decl.kind === "VarStatement") {
      const v = decl as VarStatement;
      const varName = v.name?.kind === "Identifier" ? (v.name as Identifier).name : null;
      if (varName === symbolName && (v as { typeAnnotation?: { name?: string } }).typeAnnotation?.name) {
        return typeFromAnnotationText((v as { typeAnnotation?: { name?: string } }).typeAnnotation?.name);
      }
    }

    if (
      decl.kind === "ClassStatement" ||
      decl.kind === "InterfaceStatement" ||
      decl.kind === "EnumStatement" ||
      decl.kind === "TypeAliasStatement"
    ) {
      const named = decl as unknown as { name: { name: string } };
      if (named.name?.name === symbolName) {
        return namedType(named.name.name);
      }
    }
  }
  return null;
}

/**
 * Resolves the AnalysisType for a named import (`symbolName`) from an ambient
 * module (`importName`). Handles:
 * - Direct `export function` / `export const` declarations
 * - The `export = X` + `namespace X { interface I { member } }` + `const X: ns.I`
 *   pattern used by @types/node (e.g. `path`, `node:path`)
 * - Strips the `node:` prefix and retries with the base name when needed
 */
function resolveAmbientNamedImportType(
  importName: string,
  symbolName: string,
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>
): AnalysisType | null {
  const candidates = [importName];
  if (importName.startsWith("node:")) {
    candidates.push(importName.slice("node:".length));
  }

  for (const candidate of candidates) {
    const decls = ambientModuleDeclarations.get(candidate);
    if (!decls || decls.length === 0) continue;

    // 1. Try direct export with ambient-aware type expansion
    for (const statement of decls) {
      const declaration =
        statement.kind === "ExportStatement"
          ? (statement as { declaration?: Statement }).declaration ?? statement
          : statement;

      if (declaration.kind === "FunctionStatement" && (declaration as FunctionStatement).name?.name === symbolName) {
        return buildAmbientFunctionTypeFromStatement(
          declaration as FunctionStatement,
          decls,
          ambientModuleDeclarations
        );
      }
      if (declaration.kind === "VarStatement") {
        const variable = declaration as VarStatement;
        const varName = variable.name?.kind === "Identifier" ? (variable.name as Identifier).name : null;
        if (varName === symbolName) {
          return typeFromAmbientAnnotationText(variable.typeAnnotation?.name, decls, ambientModuleDeclarations);
        }
      }
    }

    const direct = extractDirectTypeForName(decls, symbolName);
    if (direct) return direct;

    // 2. Follow export = X pattern
    const exportEqualsName = detectExportEqualsNameInDecls(decls);
    if (!exportEqualsName) continue;

    // 2a. Look directly inside namespace with the same name
    const nsBody = findNamespaceBodyInStmts(decls, exportEqualsName);
    if (nsBody) {
      const fromNs = extractDirectTypeForName(nsBody, symbolName);
      if (fromNs) return fromNs;
    }

    // 2b. Find the var statement for the export= name to get its type (e.g. `const path: path.PlatformPath`)
    for (const stmt of decls) {
      if (stmt.kind !== "VarStatement") continue;
      const v = stmt as VarStatement;
      const varName = v.name?.kind === "Identifier" ? (v.name as Identifier).name : null;
      const typeName = (v as { typeAnnotation?: { name?: string } }).typeAnnotation?.name;
      if (varName !== exportEqualsName || !typeName) continue;

      // Parse "path.PlatformPath" → namespace "path", interface "PlatformPath"
      const dotIdx = typeName.lastIndexOf(".");
      const nsName = dotIdx > 0 ? typeName.slice(0, dotIdx) : null;
      const ifaceName = dotIdx > 0 ? typeName.slice(dotIdx + 1) : typeName;

      const searchNsBody = nsName ? findNamespaceBodyInStmts(decls, nsName) : decls;
      if (!searchNsBody) continue;

      for (const s of searchNsBody) {
        const d =
          s.kind === "ExportStatement"
            ? (s as { declaration?: Statement }).declaration ?? s
            : s;
        if (d.kind !== "InterfaceStatement") continue;
        const iface = d as InterfaceStatement;
        if (iface.name?.name !== ifaceName) continue;
        const member = (iface.members ?? []).find((m) => m.name?.name === symbolName);
        if (member) return typeFromAmbientInterfaceMember(member, searchNsBody, ambientModuleDeclarations);
      }
    }
  }

  return null;
}

export interface CollectImportedDeclarationsContext extends ProjectContext {
  uri?: string;
  ambientModuleDeclarations?: ReadonlyMap<string, Statement[]>;
}

async function resolveImportTargetInContext(
  importerFilePath: string,
  importPath: string,
  context: ProjectContext
): Promise<string | null> {
  return resolveImportTargetFilePath(importerFilePath, importPath, {
    vfs: context.vfs,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });
}

function unwrapDeclaration(statement: Statement): ImportableDeclaration | null {
  if (statement.kind === "VarStatement") {
    const varStatement = statement as VarStatement;
    if (varStatement.receiverType) {
      return varStatement;
    }
  }
  if (statement.kind === "FunctionStatement") {
    const functionStatement = statement as FunctionStatement;
    if (functionStatement.receiverType && functionStatement.operator) {
      return functionStatement;
    }
  }
  const candidate = unwrapExportedDeclaration(statement);
  if (!candidate) {
    return null;
  }
  if (TYPE_DECLARATION_KINDS.has(candidate.kind)) {
    return candidate as NamedTypeDeclaration;
  }
  if (candidate.kind === "VarStatement") {
    const varStatement = candidate as VarStatement;
    if (varStatement.receiverType) {
      return varStatement;
    }
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

export interface CollectedImportedDeclarations {
  externalDeclarations: Statement[];
  importedSymbolTypes: Map<string, AnalysisType>;
}

/**
 * Collects both imported type declarations and imported symbol types in a single
 * pass over the document's import statements. Prefer this over calling
 * `collectImportedTypeDeclarations` and `collectImportedSymbolTypes` separately
 * to avoid resolving each import path twice.
 */
export async function collectAllImportedDeclarations(
  ast: Program,
  context: CollectImportedDeclarationsContext
): Promise<CollectedImportedDeclarations> {
  const currentFilePath = context.uri ? uriToFilePath(context.uri) : null;
  if (!currentFilePath) {
    return { externalDeclarations: [], importedSymbolTypes: new Map() };
  }

  const externalDeclarations: Statement[] = [];
  const importedSymbolTypes = new Map<string, AnalysisType>();
  const seen = new Set<ImportableDeclaration>();

  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const targetFilePath = await resolveImportTargetInContext(currentFilePath, importStatement.from.value, context);

    if (!targetFilePath) {
      const nodeModuleTypings = await getNodeModuleTypings(currentFilePath, importStatement.from.value, { vfs: context.vfs });
      if (nodeModuleTypings) {
        // For node_modules .d.ts files, include all top-level declarations so
        // member resolution works for named types like `moment.parseZone`.
        for (const targetStatement of nodeModuleTypings.declarations) {
          if (!seen.has(targetStatement as ImportableDeclaration)) {
            seen.add(targetStatement as ImportableDeclaration);
            externalDeclarations.push(targetStatement);
          }
        }
        if (nodeModuleTypings.defaultExportName) {
          const exportType = namedType(nodeModuleTypings.defaultExportName);
          const defaultImportType = callableTypeFromExternalFunction(nodeModuleTypings.declarations, nodeModuleTypings.defaultExportName) ?? exportType;
          if (importStatement.defaultImport) {
            importedSymbolTypes.set(importStatement.defaultImport.name, defaultImportType);
          }
          if (importStatement.namespaceImport) {
            importedSymbolTypes.set(importStatement.namespaceImport.name, exportType);
          }
          for (const specifier of importStatement.specifiers) {
            const localName = (specifier.local ?? specifier.imported).name;
            importedSymbolTypes.set(localName, exportType);
          }
        }
      } else {
        // Fall back to ambient module declarations (e.g. `declare module "fs"` loaded
        // from @types/node via tsconfig compilerOptions.types).
        const importPath = importStatement.from.value;
        const ambientDecls = context.ambientModuleDeclarations?.get(importPath);
        if (ambientDecls) {
          for (const targetStatement of ambientDecls) {
            if (!seen.has(targetStatement as ImportableDeclaration)) {
              seen.add(targetStatement as ImportableDeclaration);
              externalDeclarations.push(targetStatement);
            }
          }
          if (context.ambientModuleDeclarations) {
            for (const specifier of importStatement.specifiers) {
              const localName = (specifier.local ?? specifier.imported).name;
              const importedName = specifier.imported.name;
              const type = resolveAmbientNamedImportType(importPath, importedName, context.ambientModuleDeclarations);
              if (type) {
                importedSymbolTypes.set(localName, type);
              }
            }
          }
        }
      }
      continue;
    }

    const wantedNames = new Set(
      importStatement.specifiers.map((specifier) => specifier.imported.name)
    );

    const targetSession = await getProjectSessionForFilePath(targetFilePath, context);

    if (targetSession?.ast && wantedNames.size > 0) {
      for (const targetStatement of targetSession.ast.body) {
        const declaration = unwrapDeclaration(targetStatement);
        if (!declaration || seen.has(declaration)) {
          continue;
        }
        if (!topLevelDeclarationNames(declaration).some((name) => wantedNames.has(name))) {
          continue;
        }
        seen.add(declaration);
        externalDeclarations.push(declaration);
      }
    }

    if (targetSession?.analysis && wantedNames.size > 0) {
      for (const specifier of importStatement.specifiers) {
        const localName = (specifier.local ?? specifier.imported).name;
        const importedType = targetSession.analysis.getTopLevelSymbolType(specifier.imported.name);
        if (importedType) {
          importedSymbolTypes.set(localName, importedType);
        }
      }
    }
  }

  return { externalDeclarations, importedSymbolTypes };
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
export async function collectImportedTypeDeclarations(
  ast: Program,
  context: CollectImportedDeclarationsContext
): Promise<Statement[]> {
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
    const targetFilePath = await resolveImportTargetInContext(currentFilePath, importStatement.from.value, context);
    if (!targetFilePath) {
      // Bare specifier — load all declarations from node_modules typings so
      // named types (namespaces, interfaces) resolve for member access.
      const nodeModuleTypings = await getNodeModuleTypings(currentFilePath, importStatement.from.value, { vfs: context.vfs });
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
    const targetSession = await getProjectSessionForFilePath(targetFilePath, context);
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
export async function collectImportedSymbolTypes(
  ast: Program,
  context: CollectImportedDeclarationsContext
): Promise<Map<string, AnalysisType>> {
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
    const targetFilePath = await resolveImportTargetInContext(currentFilePath, importStatement.from.value, context);
    if (!targetFilePath) {
      // Bare specifier — assign a named type from node_modules typings so that
      // default/namespace/named imports resolve their members in hover/completion.
      const nodeModuleTypings = await getNodeModuleTypings(currentFilePath, importStatement.from.value, { vfs: context.vfs });
      if (nodeModuleTypings?.defaultExportName) {
        const exportType = namedType(nodeModuleTypings.defaultExportName);
        const defaultImportType = callableTypeFromExternalFunction(nodeModuleTypings.declarations, nodeModuleTypings.defaultExportName) ?? exportType;
        if (importStatement.defaultImport) {
          result.set(importStatement.defaultImport.name, defaultImportType);
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
    const targetSession = await getProjectSessionForFilePath(targetFilePath, context);
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
