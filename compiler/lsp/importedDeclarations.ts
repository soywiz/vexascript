import { AnalysisTypeKind } from "../analysis/types";
import { NodeKind } from "compiler/ast/ast";
import type {
  ClassStatement,
  EnumStatement,
  ExportStatement,
  FunctionParameter,
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
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { getProjectSessionForFilePath, type ProjectContext } from "./projectAnalysis";
import { uriToFilePath } from "./importFixes";
import { nodeBuiltinSpecifierCandidates, resolveImportTargetFilePath } from "compiler/moduleResolution";
import { importableTopLevelDeclarationNames } from "./declarationResolver";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { detectAmbientExportEqualsName, findAmbientNamespaceBody, findImportBindingByLocalName, importBindings, importStatementBindings } from "./crossFileContext";
import {
  renderAmbientFunctionDisplayFromStatement,
  renderAmbientInterfaceMemberDisplay,
  renderAmbientTypeAnnotationText
} from "./ambientDisplay";
import type { AnalysisType, ArrayType, ObjectType } from "compiler/analysis/types";
import {
  BUILTIN_TYPE_NAMES,
  arrayType,
  builtinType,
  FunctionType,
  functionType,
  intersectionType,
  literalType,
  namedType,
  objectTypeWithProperties,
  tupleType,
  unionType,
  typeToString,
  UNKNOWN_TYPE
} from "compiler/analysis/types";
import {
  findMatchingTypeDelimiter,
  parseAssertionTypePredicateText,
  parseConditionalTypeText,
  parseReadonlyContainerTypeText,
  parseTemplateLiteralTypeText,
  findTopLevelTypeCharacter,
  parseFunctionTypeAnnotation,
  parseTypeNameShape,
  splitTopLevelDelimitedTypeText,
  splitTopLevelTypeText,
  stripEnclosingTypeParens,
  tupleElementTypeText
} from "compiler/analysis/typeNames";
import { combineTypes, removeNullishFromType, unwrapPromiseType } from "compiler/analysis/typeOperations";
import {
  getNodeModuleTypings,
  getNodeModuleTypingsForImportNames,
  nodeModuleExportedNamesForStatement
} from "./nodeModulesTypings";
import {
  collectInvalidImportedBindings,
  getImportedSymbolResolution,
  type ImportedSymbolDeclarationOrigin,
  type ImportedSymbolResolution
} from "compiler/importedSymbols";

/**
 * Top-level declarations that contribute a named type and whose members the
 * single-file analysis may need to resolve across files (e.g. the receiver of an
 * extension method declared on an imported class).
 */
const TYPE_DECLARATION_KINDS = new Set<Statement["kind"]>([
  NodeKind.ClassStatement,
  NodeKind.InterfaceStatement,
  NodeKind.EnumStatement,
  NodeKind.TypeAliasStatement
]);

type NamedTypeDeclaration =
  | ClassStatement
  | InterfaceStatement
  | EnumStatement
  | TypeAliasStatement;

type ImportableDeclaration = NamedTypeDeclaration | FunctionStatement | VarStatement;

interface NodeModuleResolutionCache {
  namedImportTypes: Map<string, AnalysisType | null>;
  namedImportDisplayTypes: Map<string, string | null>;
  functionDisplayTypes: Map<string, string | null>;
  defaultImportTypes: Map<string, AnalysisType>;
  namespaceExportProperties?: Record<string, AnalysisType>;
}

interface AmbientModuleResolutionCache {
  defaultImportTypes: Map<string, AnalysisType | null>;
  namedImportTypes: Map<string, AnalysisType | null>;
  namedImportDisplayTypes: Map<string, string | null>;
}

const nodeModuleResolutionCaches = new WeakMap<readonly Statement[], NodeModuleResolutionCache>();
const ambientModuleResolutionCaches = new WeakMap<ReadonlyMap<string, Statement[]>, AmbientModuleResolutionCache>();

interface NodeModuleDeclarationIndex {
  declarationsByName: Map<string, Statement[]>;
  dependencyNamesByStatement: WeakMap<Statement, readonly string[]>;
  localExportBindingNamesByExportedName: Map<string, readonly string[]>;
}

const nodeModuleDeclarationIndexes = new WeakMap<readonly Statement[], NodeModuleDeclarationIndex>();

function getNodeModuleResolutionCache(declarations: readonly Statement[]): NodeModuleResolutionCache {
  const cached = nodeModuleResolutionCaches.get(declarations);
  if (cached) {
    return cached;
  }
  const created: NodeModuleResolutionCache = {
    namedImportTypes: new Map(),
    namedImportDisplayTypes: new Map(),
    functionDisplayTypes: new Map(),
    defaultImportTypes: new Map()
  };
  nodeModuleResolutionCaches.set(declarations, created);
  return created;
}

function getAmbientModuleResolutionCache(
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>
): AmbientModuleResolutionCache {
  const cached = ambientModuleResolutionCaches.get(ambientModuleDeclarations);
  if (cached) {
    return cached;
  }
  const created: AmbientModuleResolutionCache = {
    defaultImportTypes: new Map(),
    namedImportTypes: new Map(),
    namedImportDisplayTypes: new Map()
  };
  ambientModuleResolutionCaches.set(ambientModuleDeclarations, created);
  return created;
}

function getNodeModuleDeclarationIndex(declarations: readonly Statement[]): NodeModuleDeclarationIndex {
  const cached = nodeModuleDeclarationIndexes.get(declarations);
  if (cached) {
    return cached;
  }

  const declarationsByName = new Map<string, Statement[]>();
  const dependencyNamesByStatement = new WeakMap<Statement, readonly string[]>();
  const localExportBindingNamesByExportedName = new Map<string, string[]>();

  for (const declaration of declarations) {
    const declarationName = importableDeclarationName(declaration);
    if (declarationName) {
      const existing = declarationsByName.get(declarationName);
      if (existing) {
        existing.push(declaration);
      } else {
        declarationsByName.set(declarationName, [declaration]);
      }
    }

    const dependencyNames = new Set<string>();
    collectTypeQueryDependencyNames(declaration, dependencyNames);
    dependencyNamesByStatement.set(declaration, [...dependencyNames]);

    if (detectAmbientExportEqualsName([declaration])) {
      const exportedName = detectAmbientExportEqualsName([declaration])!;
      const existing = localExportBindingNamesByExportedName.get(exportedName) ?? [];
      if (!existing.includes(exportedName)) {
        localExportBindingNamesByExportedName.set(exportedName, [...existing, exportedName]);
      }
    }

    if (declaration.kind === NodeKind.ExportStatement) {
      const exportStatement = declaration as { specifiers?: Array<{ exported: Identifier; local?: Identifier }> };
      for (const specifier of exportStatement.specifiers ?? []) {
        const existing = localExportBindingNamesByExportedName.get(specifier.exported.name) ?? [];
        const localName = specifier.local?.name ?? specifier.exported.name;
        if (!existing.includes(localName)) {
          localExportBindingNamesByExportedName.set(specifier.exported.name, [...existing, localName]);
        }
      }
    }
  }

  const created: NodeModuleDeclarationIndex = {
    declarationsByName,
    dependencyNamesByStatement,
    localExportBindingNamesByExportedName
  };
  nodeModuleDeclarationIndexes.set(declarations, created);
  return created;
}

function dedupeAnalysisTypes(types: AnalysisType[]): AnalysisType[] {
  const seen = new Set<string>();
  const result: AnalysisType[] = [];
  for (const type of types) {
    const key = typeToString(type);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(type);
  }
  return result;
}

function importedAssertionTypeFromText(
  typeName: string | undefined,
  declarations: readonly Statement[],
  resolvingImportTypes: Set<string> = new Set(),
  ambientModuleDeclarations?: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[] = [],
  visited: Set<string> = new Set()
): { target: string; type?: AnalysisType } | undefined {
  if (!typeName) {
    return undefined;
  }
  const parsed = parseAssertionTypePredicateText(typeName);
  if (!parsed) {
    return undefined;
  }
  const resolvedType = parsed.assertedTypeText
    ? (ambientModuleDeclarations
        ? typeFromAmbientAnnotationText(parsed.assertedTypeText, declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
        : typeFromAnnotationText(parsed.assertedTypeText, declarations, resolvingImportTypes))
    : undefined;
  return {
    target: parsed.targetText,
    ...(resolvedType ? { type: resolvedType } : {})
  };
}

function unionIfNeeded(types: AnalysisType[]): AnalysisType {
  const unique = dedupeAnalysisTypes(types);
  if (unique.length === 0) {
    return UNKNOWN_TYPE;
  }
  if (unique.length === 1) {
    return unique[0]!;
  }
  return unionType(unique);
}

function importedTypeParameterTypeMap<T extends { name: Identifier }>(
  typeParameters: readonly T[] | undefined,
  selectTypeName: (parameter: T) => string | undefined,
  declarations: readonly Statement[] = [],
  resolvingImportTypes: Set<string> = new Set()
): Record<string, AnalysisType> | undefined {
  const entries = (typeParameters ?? [])
    .map((parameter) => {
      const typeName = selectTypeName(parameter);
      return typeName
        ? [parameter.name.name, typeFromAnnotationText(typeName, declarations, resolvingImportTypes)] as const
        : null;
    })
    .filter((entry): entry is readonly [string, AnalysisType] => entry !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function importedTypeParameterConstraintMap(
  typeParameters: readonly { name: Identifier; constraint?: { name?: string } | undefined }[] | undefined,
  declarations: readonly Statement[] = [],
  resolvingImportTypes: Set<string> = new Set()
): Record<string, AnalysisType> | undefined {
  return importedTypeParameterTypeMap(typeParameters, (parameter) => parameter.constraint?.name, declarations, resolvingImportTypes);
}

function importedTypeParameterDefaultMap(
  typeParameters: readonly { name: Identifier; defaultType?: { name?: string } | undefined }[] | undefined,
  declarations: readonly Statement[] = [],
  resolvingImportTypes: Set<string> = new Set()
): Record<string, AnalysisType> | undefined {
  return importedTypeParameterTypeMap(typeParameters, (parameter) => parameter.defaultType?.name, declarations, resolvingImportTypes);
}

function localExportBindingNamesForExportedName(
  declarations: readonly Statement[],
  exportedName: string
): Set<string> {
  return new Set(
    getNodeModuleDeclarationIndex(declarations).localExportBindingNamesByExportedName.get(exportedName) ?? []
  );
}

interface ImportTypeReferenceText {
  kind: "import-type" | "type-query";
  moduleName: string;
  memberPath: string[];
}

function parseImportTypeReferenceText(typeName: string): ImportTypeReferenceText | null {
  const trimmed = stripEnclosingTypeParens(typeName.trim());
  let body = trimmed;
  let kind: ImportTypeReferenceText["kind"] = "import-type";
  if (body.startsWith("typeof ")) {
    body = body.slice("typeof ".length).trim();
    kind = "type-query";
  }
  if (!body.startsWith("import(")) {
    return null;
  }

  const closeParenIndex = findMatchingTypeDelimiter(body, "import".length, "(", ")");
  if (closeParenIndex < 0) {
    return null;
  }
  const moduleLiteral = body.slice("import(".length, closeParenIndex).trim();
  if (
    moduleLiteral.length < 2
    || (moduleLiteral[0] !== "\"" && moduleLiteral[0] !== "'")
    || moduleLiteral[moduleLiteral.length - 1] !== moduleLiteral[0]
  ) {
    return null;
  }
  const moduleName = moduleLiteral.slice(1, -1);
  const suffix = body.slice(closeParenIndex + 1).trim();
  if (suffix.length === 0) {
    return { kind, moduleName, memberPath: [] };
  }
  if (!suffix.startsWith(".")) {
    return null;
  }
  const memberText = suffix.slice(1).trim();
  if (memberText.length === 0) {
    return null;
  }
  return {
    kind,
    moduleName,
    memberPath: splitTopLevelDelimitedTypeText(memberText, new Set(["."]))
  };
}

function propertyTypeFromObjectLikeType(type: AnalysisType, propertyName: string): AnalysisType | null {
  const properties = ambientObjectProperties(type);
  return properties?.[propertyName] ?? null;
}

function resolveImportTypeQueryMembers(baseType: AnalysisType, memberPath: readonly string[]): AnalysisType {
  let currentType = baseType;
  for (const segmentText of memberPath) {
    const parsed = parseTypeNameShape(segmentText);
    if (parsed.typeArguments.length > 0 || parsed.arrayDepth > 0) {
      return UNKNOWN_TYPE;
    }
    currentType = propertyTypeFromObjectLikeType(currentType, parsed.baseName) ?? UNKNOWN_TYPE;
    if (currentType === UNKNOWN_TYPE) {
      return UNKNOWN_TYPE;
    }
  }
  return currentType;
}

function resolveNodeModuleImportTypeReference(
  typeName: string,
  declarations: readonly Statement[],
  resolvingImportTypes: Set<string>
): AnalysisType | null {
  const importTypeReference = parseImportTypeReferenceText(typeName);
  if (!importTypeReference) {
    return null;
  }

  const visitKey = `${importTypeReference.kind}:${importTypeReference.moduleName}:${importTypeReference.memberPath.join(".")}`;
  if (resolvingImportTypes.has(visitKey)) {
    return UNKNOWN_TYPE;
  }
  resolvingImportTypes.add(visitKey);
  try {
    if (importTypeReference.kind === "type-query" && importTypeReference.memberPath.length > 0) {
      const [firstMember, ...restMembers] = importTypeReference.memberPath;
      const parsedFirstMember = parseTypeNameShape(firstMember ?? "");
      if (
        firstMember
        && parsedFirstMember.baseName === firstMember
        && parsedFirstMember.typeArguments.length === 0
        && parsedFirstMember.arrayDepth === 0
      ) {
        const directExportType = resolveNodeModuleNamedImportType(declarations, parsedFirstMember.baseName, resolvingImportTypes);
        if (directExportType) {
          return restMembers.length === 0
            ? directExportType
            : resolveImportTypeQueryMembers(directExportType, restMembers);
        }
      }
    }

    if (importTypeReference.kind === "import-type") {
      if (importTypeReference.memberPath.length > 0) {
        const referencedTypeText = importTypeReference.memberPath.join(".");
        const parsed = parseTypeNameShape(referencedTypeText);
        if (
          importTypeReference.memberPath.length === 1
          && parsed.baseName === referencedTypeText
          && parsed.typeArguments.length === 0
          && parsed.arrayDepth === 0
        ) {
          const directExportType = resolveNodeModuleNamedImportType(declarations, parsed.baseName, resolvingImportTypes);
          if (directExportType) {
            return directExportType;
          }
        }
        return typeFromAnnotationText(referencedTypeText, declarations, resolvingImportTypes);
      }
    }

    const namespaceProperties = collectNodeModuleNamespaceExportedProperties(declarations);
    const namespaceType = objectTypeWithProperties(namespaceProperties);
    if (importTypeReference.kind === "type-query") {
      return importTypeReference.memberPath.length === 0
        ? namespaceType
        : resolveImportTypeQueryMembers(namespaceType, importTypeReference.memberPath);
    }
    return namespaceType;
  } finally {
    resolvingImportTypes.delete(visitKey);
  }
}

function typeFromAnnotationText(
  typeName: string | undefined,
  declarations: readonly Statement[] = [],
  resolvingImportTypes: Set<string> = new Set()
): AnalysisType {
  if (!typeName) {
    return UNKNOWN_TYPE;
  }
  const normalized = stripEnclosingTypeParens(typeName.trim());
  const importedType = resolveNodeModuleImportTypeReference(normalized, declarations, resolvingImportTypes);
  if (importedType) {
    return importedType;
  }
  const typeQueryType = resolveNodeModuleTypeQueryReference(normalized, declarations, resolvingImportTypes);
  if (typeQueryType) {
    return typeQueryType;
  }
  if (normalized === "unique symbol") {
    return builtinType("symbol");
  }
  if (normalized.startsWith("asserts ")) {
    return builtinType("void");
  }
  const readonlyContainer = parseReadonlyContainerTypeText(normalized);
  if (readonlyContainer?.kind === "tuple") {
    return tupleType(
      (readonlyContainer.tupleElementTypeTexts ?? []).map((part) =>
        typeFromAnnotationText(tupleElementTypeText(part), declarations, resolvingImportTypes)
      ),
      true
    );
  }
  if (readonlyContainer?.kind === "array" && readonlyContainer.elementTypeText) {
    return arrayType(
      typeFromAnnotationText(readonlyContainer.elementTypeText, declarations, resolvingImportTypes),
      true
    );
  }
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    const members = splitTopLevelDelimitedTypeText(normalized.slice(1, -1), new Set([","]));
    return tupleType(
      members
        .map((member) => typeFromAnnotationText(tupleElementTypeText(member.trim()), declarations, resolvingImportTypes))
        .filter((member) => member !== UNKNOWN_TYPE)
    );
  }
  const parsedFunctionType = parseFunctionTypeAnnotation(normalized);
  if (parsedFunctionType) {
    return functionType(
      parsedFunctionType.parameters.map((parameter) => ({
        name: parameter.name,
        type: typeFromAnnotationText(
          parameter.typeName,
          declarations,
          resolvingImportTypes
        ),
        ...(parameter.optional ? { optional: true } : {}),
        ...(parameter.rest ? { rest: true } : {})
      })),
      typeFromAnnotationText(parsedFunctionType.returnTypeName, declarations, resolvingImportTypes),
      parsedFunctionType.typeParameters,
      parsedFunctionType.typeParameterConstraints
        ? Object.fromEntries(
            Object.entries(parsedFunctionType.typeParameterConstraints).map(([name, constraintTypeName]) => [
              name,
              typeFromAnnotationText(constraintTypeName, declarations, resolvingImportTypes)
            ])
          )
        : undefined,
      parsedFunctionType.typeParameterDefaults
        ? Object.fromEntries(
            Object.entries(parsedFunctionType.typeParameterDefaults).map(([name, defaultTypeName]) => [
              name,
              typeFromAnnotationText(defaultTypeName, declarations, resolvingImportTypes)
            ])
          )
        : undefined,
      importedAssertionTypeFromText(parsedFunctionType.returnTypeName, declarations, resolvingImportTypes)
    );
  }
  const unionParts = splitTopLevelTypeText(normalized, "|");
  if (unionParts.length > 1) {
    return unionType(unionParts.map((part) => typeFromAnnotationText(part, declarations, resolvingImportTypes)));
  }
  const intersectionParts = splitTopLevelTypeText(normalized, "&");
  if (intersectionParts.length > 1) {
    return intersectionType(intersectionParts.map((part) => typeFromAnnotationText(part, declarations, resolvingImportTypes)));
  }
  const parsed = parseTypeNameShape(normalized);
  const resolvedTypeArguments = parsed.typeArguments.map((argument) =>
    typeFromAnnotationText(argument, declarations, resolvingImportTypes)
  );
  let resolvedBase: AnalysisType = BUILTIN_TYPE_NAMES.has(parsed.baseName)
    ? builtinType(parsed.baseName as Parameters<typeof builtinType>[0])
    : namedType(parsed.baseName, resolvedTypeArguments);
  for (let depth = 0; depth < parsed.arrayDepth; depth += 1) {
    resolvedBase = arrayType(resolvedBase);
  }
  return resolvedBase;
}

function resolveNodeModuleTypeQueryReference(
  typeName: string,
  declarations: readonly Statement[],
  resolvingImportTypes: Set<string>
): AnalysisType | null {
  if (!typeName.startsWith("typeof ")) {
    return null;
  }
  const path = typeName.slice("typeof ".length).trim().split(".").filter((part) => part.length > 0);
  const baseName = path.shift();
  if (!baseName) {
    return UNKNOWN_TYPE;
  }
  const cacheKey = `typeof:${baseName}`;
  if (resolvingImportTypes.has(cacheKey)) {
    return UNKNOWN_TYPE;
  }
  resolvingImportTypes.add(cacheKey);
  try {
    const candidates = getNodeModuleDeclarationIndex(declarations).declarationsByName.get(baseName) ?? [];
    for (const candidate of candidates) {
      const declaration = unwrapExportedDeclaration(candidate);
      let resolved: AnalysisType | null = null;
      if (declaration?.kind === NodeKind.FunctionStatement) {
        resolved = buildFunctionTypeFromStatement(
          declaration as FunctionStatement,
          declarations,
          resolvingImportTypes
        );
      } else if (declaration?.kind === NodeKind.VarStatement) {
        const variable = declaration as VarStatement;
        resolved = typeFromAnnotationText(
          variable.declarations?.[0]?.typeAnnotation?.name ?? variable.typeAnnotation?.name,
          declarations,
          resolvingImportTypes
        );
      } else if (declaration?.kind === NodeKind.ClassStatement) {
        resolved = namedType((declaration as ClassStatement).name.name);
      }
      if (!resolved) {
        continue;
      }
      return path.length > 0
        ? resolveImportTypeQueryMembers(resolved, path)
        : resolved;
    }
    return UNKNOWN_TYPE;
  } finally {
    resolvingImportTypes.delete(cacheKey);
  }
}

function externalFunctionOverloads(
  declarations: readonly Statement[],
  name: string,
  resolvingImportTypes: Set<string> = new Set()
): FunctionType[] {
  const declarationIndex = getNodeModuleDeclarationIndex(declarations);
  const locallyExportedNames = localExportBindingNamesForExportedName(declarations, name);
  const candidateNames = new Set<string>([name, ...locallyExportedNames]);
  const overloads: FunctionType[] = [];
  const seenStatements = new Set<Statement>();
  for (const candidateName of candidateNames) {
    for (const statement of declarationIndex.declarationsByName.get(candidateName) ?? []) {
      if (seenStatements.has(statement)) {
        continue;
      }
      seenStatements.add(statement);
      const declaration = unwrapExportedDeclaration(statement);
      if (declaration?.kind !== NodeKind.FunctionStatement) {
        continue;
      }
      const fn = declaration as FunctionStatement;
      overloads.push(functionType(
        mapFunctionParameters(fn.parameters, (name) => typeFromAnnotationText(name, declarations, resolvingImportTypes)),
        typeFromAnnotationText(fn.returnType?.name, declarations, resolvingImportTypes),
        fn.typeParameters?.map((parameter) => parameter.name.name),
        importedTypeParameterConstraintMap(fn.typeParameters),
        importedTypeParameterDefaultMap(fn.typeParameters),
        importedAssertionTypeFromText(fn.returnType?.name, declarations, resolvingImportTypes)
      ));
    }
  }
  return overloads;
}

function callableTypeFromExternalFunction(
  declarations: readonly Statement[],
  name: string,
  resolvingImportTypes: Set<string> = new Set()
): AnalysisType | null {
  const overloads = externalFunctionOverloads(declarations, name, resolvingImportTypes);
  if (overloads.length === 0) {
    return null;
  }
  // Preserve external overloads as distinct callable candidates so the type
  // checker can select the right signature at call sites instead of widening
  // the return type into a single merged function.
  return overloads.length === 1 ? overloads[0]! : unionType(overloads);
}

function displayTypeForExternalFunction(declarations: readonly Statement[], name: string): string | null {
  const resolutionCache = getNodeModuleResolutionCache(declarations);
  const cached = resolutionCache.functionDisplayTypes.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const overloads = externalFunctionOverloads(declarations, name);
  if (overloads.length === 0) {
    resolutionCache.functionDisplayTypes.set(name, null);
    return null;
  }
  if (overloads.length === 1) {
    const display = typeToString(overloads[0]!);
    resolutionCache.functionDisplayTypes.set(name, display);
    return display;
  }
  const display = overloads.map((overload) => typeToString(overload)).join(" | ");
  resolutionCache.functionDisplayTypes.set(name, display);
  return display;
}

function resolveNodeModuleNamedImportType(
  declarations: readonly Statement[],
  importedName: string,
  resolvingImportTypes: Set<string> = new Set()
): AnalysisType | null {
  const resolutionCache = getNodeModuleResolutionCache(declarations);
  const declarationIndex = getNodeModuleDeclarationIndex(declarations);
  const cached = resolutionCache.namedImportTypes.get(importedName);
  if (cached !== undefined) {
    return cached;
  }
  const callableType = callableTypeFromExternalFunction(declarations, importedName, resolvingImportTypes);
  if (callableType) {
    resolutionCache.namedImportTypes.set(importedName, callableType);
    return callableType;
  }

  const locallyExportedNames = localExportBindingNamesForExportedName(declarations, importedName);
  const candidateNames = new Set<string>([importedName, ...locallyExportedNames]);
  const seenStatements = new Set<Statement>();
  for (const candidateName of candidateNames) {
    for (const statement of declarationIndex.declarationsByName.get(candidateName) ?? []) {
      if (seenStatements.has(statement)) {
        continue;
      }
      seenStatements.add(statement);
      const declaration = unwrapExportedDeclaration(statement) ?? statement;
      if (declaration.kind === NodeKind.ClassStatement) {
        const resolved = namedType(importedName);
        resolutionCache.namedImportTypes.set(importedName, resolved);
        return resolved;
      }
      if (declaration.kind === NodeKind.InterfaceStatement) {
        const resolved = namedType(importedName);
        resolutionCache.namedImportTypes.set(importedName, resolved);
        return resolved;
      }
      if (declaration.kind === NodeKind.EnumStatement) {
        const resolved = namedType(importedName);
        resolutionCache.namedImportTypes.set(importedName, resolved);
        return resolved;
      }
      if (declaration.kind === NodeKind.TypeAliasStatement) {
        const resolved = namedType(importedName);
        resolutionCache.namedImportTypes.set(importedName, resolved);
        return resolved;
      }
      if (declaration.kind === NodeKind.NamespaceStatement) {
        const namespaceName = (declaration as NamespaceStatement).names?.[0]?.name;
        if (namespaceName === candidateName) {
          const resolved = nodeModuleNamespaceStatementType(declaration as NamespaceStatement);
          resolutionCache.namedImportTypes.set(importedName, resolved);
          return resolved;
        }
      }
      if (declaration.kind === NodeKind.VarStatement) {
        const varStatement = declaration as VarStatement;
        if (varStatement.name.kind === NodeKind.Identifier) {
          const resolved = typeFromAnnotationText(varStatement.typeAnnotation?.name, declarations, resolvingImportTypes);
          resolutionCache.namedImportTypes.set(importedName, resolved);
          return resolved;
        }
      }
    }
  }

  for (const statement of declarations) {
    const importStatement = (
      statement.kind === NodeKind.ImportStatement
        ? statement
        : statement.kind === NodeKind.ExportStatement && (statement as { declaration?: Statement }).declaration?.kind === NodeKind.ImportStatement
          ? (statement as { declaration?: ImportStatement }).declaration!
          : null
    ) as ImportStatement | null;
    if (!importStatement) {
      continue;
    }
    for (const binding of importStatementBindings(importStatement)) {
      if (binding.localName !== importedName) {
        continue;
      }
      if (binding.kind === "namespace") {
        const resolved = objectTypeWithProperties(collectNodeModuleNamespaceExportedProperties(declarations));
        resolutionCache.namedImportTypes.set(importedName, resolved);
        return resolved;
      }
      // Follow renamed re-imports (`import { a as b }`) to their source name;
      // skip non-renamed bindings to avoid resolving a name through itself.
      if (binding.kind === "named" && binding.importedName !== importedName) {
        const resolved = resolveNodeModuleNamedImportType(declarations, binding.importedName, resolvingImportTypes);
        resolutionCache.namedImportTypes.set(importedName, resolved);
        return resolved;
      }
    }
  }

  resolutionCache.namedImportTypes.set(importedName, null);
  return null;
}

/**
 * Maps a parameter list to the `functionType(...)` parameter shape, applying the
 * same `this`-parameter filtering, rest-element unwrapping, and optional/rest
 * flags everywhere. The caller supplies `resolveType`, which is the only thing
 * that differs between the import-typed and ambient-typed callers.
 */
function mapFunctionParameters(
  parameters: readonly FunctionParameter[],
  resolveType: (typeName: string | undefined) => AnalysisType
): Array<{ name: string; type: AnalysisType; optional: boolean; rest: boolean }> {
  return parameters
    .filter((parameter) => parameter.thisParameter !== true)
    .map((parameter) => {
      const rawType = resolveType(parameter.typeAnnotation?.name);
      const isRest = parameter.rest === true;
      const type = isRest && rawType.kind === AnalysisTypeKind.Array ? (rawType as ArrayType).elementType : rawType;
      return {
        name: parameter.name.kind === NodeKind.Identifier ? (parameter.name as Identifier).name : "arg",
        type,
        optional: parameter.optional === true || parameter.defaultValue !== undefined || isRest,
        rest: isRest
      };
    });
}

export function buildFunctionTypeFromStatement(
  fn: FunctionStatement,
  declarations: readonly Statement[] = [],
  resolvingImportTypes: Set<string> = new Set()
): AnalysisType {
  return functionType(
    mapFunctionParameters(fn.parameters, (name) => typeFromAnnotationText(name, declarations, resolvingImportTypes)),
    typeFromAnnotationText(fn.returnType?.name, declarations, resolvingImportTypes),
    fn.typeParameters?.map((tp) => tp.name.name),
    importedTypeParameterConstraintMap(fn.typeParameters, declarations, resolvingImportTypes),
    importedTypeParameterDefaultMap(fn.typeParameters, declarations, resolvingImportTypes),
    importedAssertionTypeFromText(fn.returnType?.name, declarations, resolvingImportTypes)
  );
}

function findAmbientDeclarationByKindAndName(
  declarations: readonly Statement[],
  kind: Statement["kind"],
  name: string
): Statement | null {
  for (const statement of declarations) {
    const declaration = unwrapExportedDeclaration(statement) ?? statement;
    if (declaration.kind === kind && (declaration as { name?: { name?: string } }).name?.name === name) {
      return declaration;
    }
  }
  return null;
}

function findAmbientTypeAliasStatement(
  declarations: readonly Statement[],
  typeName: string
): TypeAliasStatement | null {
  return findAmbientDeclarationByKindAndName(declarations, NodeKind.TypeAliasStatement, typeName) as TypeAliasStatement | null;
}

function findAmbientInterfaceStatement(
  declarations: readonly Statement[],
  typeName: string
): InterfaceStatement | null {
  return findAmbientDeclarationByKindAndName(declarations, NodeKind.InterfaceStatement, typeName) as InterfaceStatement | null;
}

function parseAmbientObjectTypeAnnotation(
  typeName: string
): Array<{ name: string; typeName: string; optional: boolean }> | null {
  const trimmed = typeName.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  const body = trimmed.slice(1, -1).trim();
  if (body.length === 0) {
    return [];
  }

  const members = splitTopLevelDelimitedTypeText(body, new Set([",", ";"]));
  const parsedMembers: Array<{ name: string; typeName: string; optional: boolean }> = [];
  for (const member of members) {
    const separatorIndex = findTopLevelTypeCharacter(member, ":");
    if (separatorIndex < 0) {
      return null;
    }
    const rawName = member.slice(0, separatorIndex).trim();
    const propertyType = member.slice(separatorIndex + 1).trim();
    if (!rawName || !propertyType) {
      return null;
    }
    const optional = rawName.endsWith("?");
    parsedMembers.push({
      name: optional ? rawName.slice(0, -1).trim() : rawName,
      typeName: propertyType,
      optional
    });
  }
  return parsedMembers;
}

function mergeAmbientObjectProperties(
  target: Record<string, AnalysisType>,
  source: Record<string, AnalysisType>
): void {
  for (const [name, type] of Object.entries(source)) {
    target[name] = type;
  }
}

function ambientObjectProperties(type: AnalysisType): Record<string, AnalysisType> | null {
  if (type.kind === AnalysisTypeKind.Object) {
    return Object.fromEntries((type as ObjectType).properties);
  }
  if (type.kind === AnalysisTypeKind.Intersection) {
    const merged: Record<string, AnalysisType> = {};
    let foundObject = false;
    for (const memberType of type.types) {
      const properties = ambientObjectProperties(memberType);
      if (!properties) {
        continue;
      }
      foundObject = true;
      mergeAmbientObjectProperties(merged, properties);
    }
    return foundObject ? merged : null;
  }
  return null;
}

function ambientStringLiteralKeys(type: AnalysisType): string[] {
  if (type.kind === AnalysisTypeKind.Literal && type.base === "string") {
    return [String(type.value)];
  }
  if (type.kind === AnalysisTypeKind.Union) {
    return type.types.flatMap((member) => ambientStringLiteralKeys(member));
  }
  return [];
}

function ambientPropertyTypeWithUndefined(type: AnalysisType): AnalysisType {
  return type.kind === AnalysisTypeKind.Union && type.types.some((member) => member.kind === AnalysisTypeKind.Builtin && member.name === "undefined")
    ? type
    : unionType([type, builtinType("undefined")]);
}

function ambientPropertyTypeWithoutUndefined(type: AnalysisType): AnalysisType {
  if (type.kind !== AnalysisTypeKind.Union) {
    return type;
  }
  const definedMembers = type.types.filter(
    (member) => !(member.kind === AnalysisTypeKind.Builtin && member.name === "undefined")
  );
  if (definedMembers.length === 0 || definedMembers.length === type.types.length) {
    return type;
  }
  return definedMembers.length === 1 ? definedMembers[0]! : unionType(definedMembers);
}

function parseAmbientIndexedAccess(typeName: string): { baseTypeName: string; indexTypeName: string } | null {
  const trimmed = typeName.trim();
  if (!trimmed.endsWith("]")) {
    return null;
  }
  const bracketStart = findTopLevelTypeCharacter(trimmed, "[");
  if (bracketStart <= 0) {
    return null;
  }
  const baseTypeName = trimmed.slice(0, bracketStart).trim();
  const indexTypeName = trimmed.slice(bracketStart + 1, -1).trim();
  if (!baseTypeName || !indexTypeName) {
    return null;
  }
  return { baseTypeName, indexTypeName };
}

function objectTypeFromAmbientAnnotationText(
  typeName: string,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType | null {
  const members = parseAmbientObjectTypeAnnotation(typeName);
  if (!members) {
    return null;
  }
  const properties: Record<string, AnalysisType> = {};
  for (const member of members) {
    const propertyType = typeFromAmbientAnnotationText(
      member.typeName,
      declarations,
      ambientModuleDeclarations,
      ambientGlobalDeclarations,
      visited
    );
    properties[member.name] = member.optional
      ? unionType([propertyType, builtinType("undefined")])
      : propertyType;
  }
  return objectTypeWithProperties(properties);
}

function objectTypeFromAmbientInterfaceStatement(
  interfaceStatement: InterfaceStatement,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType {
  const visitKey = `interface:${interfaceStatement.name.name}`;
  if (visited.has(visitKey)) {
    return namedType(interfaceStatement.name.name);
  }
  visited.add(visitKey);
  const properties: Record<string, AnalysisType> = {};
  try {
    for (const extendsType of interfaceStatement.extendsTypes ?? []) {
      const parentType = typeFromAmbientAnnotationText(
        extendsType.name,
        declarations,
        ambientModuleDeclarations,
        ambientGlobalDeclarations,
        visited
      );
      const parentProperties = ambientObjectProperties(parentType);
      if (parentProperties) {
        mergeAmbientObjectProperties(properties, parentProperties);
      }
    }
    for (const member of interfaceStatement.members) {
      const memberType = typeFromAmbientInterfaceMember(
        member,
        declarations,
        ambientModuleDeclarations,
        ambientGlobalDeclarations,
        visited
      );
      const optional = (member as { optional?: boolean }).optional === true;
      properties[member.name.name] = optional
        ? unionType([memberType, builtinType("undefined")])
        : memberType;
    }
  } finally {
    visited.delete(visitKey);
  }
  return objectTypeWithProperties(properties);
}

function resolveAmbientImportTypeReference(
  typeName: string,
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType | null {
  const importTypeReference = parseImportTypeReferenceText(typeName);
  if (!importTypeReference) {
    return null;
  }

  const moduleNamespaceType = resolveAmbientDefaultImportType(
    importTypeReference.moduleName,
    ambientModuleDeclarations,
    ambientGlobalDeclarations
  );
  if (importTypeReference.kind === "type-query") {
    if (!moduleNamespaceType) {
      return null;
    }
    return importTypeReference.memberPath.length === 0
      ? moduleNamespaceType
      : resolveImportTypeQueryMembers(moduleNamespaceType, importTypeReference.memberPath);
  }

  if (importTypeReference.memberPath.length === 0) {
    return moduleNamespaceType;
  }

  const referencedTypeText = importTypeReference.memberPath.join(".");
  return resolveAmbientTypeReference(
    importTypeReference.moduleName,
    referencedTypeText,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  );
}

function resolveAmbientQualifiedImportedType(
  qualifiedTypeName: string,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType | null {
  const dotIndex = qualifiedTypeName.indexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  const localNamespaceName = qualifiedTypeName.slice(0, dotIndex).trim();
  const nestedTypeName = qualifiedTypeName.slice(dotIndex + 1).trim();
  if (!localNamespaceName || !nestedTypeName) {
    return null;
  }

  for (const binding of importBindings(declarations)) {
    if (binding.kind !== "namespace" || binding.localName !== localNamespaceName) {
      continue;
    }
    return resolveAmbientTypeReference(
      binding.from,
      nestedTypeName,
      ambientModuleDeclarations,
      ambientGlobalDeclarations,
      visited
    );
  }

  return null;
}

function applyAmbientUtilityType(
  utilityTypeName: string,
  typeArguments: readonly string[],
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType | null {
  if (typeArguments.length === 0) {
    return null;
  }

  if (utilityTypeName === "Exclude") {
    return ambientFilterUtilityType(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited),
      typeFromAmbientAnnotationText(typeArguments[1] ?? "never", declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited),
      false
    );
  }

  if (utilityTypeName === "Extract") {
    return ambientFilterUtilityType(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited),
      typeFromAmbientAnnotationText(typeArguments[1] ?? "never", declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited),
      true
    );
  }

  if (utilityTypeName === "NonNullable") {
    return ambientNonNullableUtilityType(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
    );
  }

  if (utilityTypeName === "Record" && typeArguments.length >= 2) {
    return ambientRecordUtilityType(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited),
      typeFromAmbientAnnotationText(typeArguments[1], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
    );
  }

  if (utilityTypeName === "ReturnType") {
    return ambientReturnTypeUtility(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
    );
  }

  if (utilityTypeName === "Parameters") {
    return ambientParametersUtility(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
    );
  }

  if (utilityTypeName === "ConstructorParameters") {
    return ambientConstructorParametersUtility(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited),
      declarations,
      ambientModuleDeclarations,
      ambientGlobalDeclarations,
      visited
    );
  }

  if (utilityTypeName === "InstanceType") {
    return ambientInstanceTypeUtility(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited),
      declarations,
      ambientModuleDeclarations,
      ambientGlobalDeclarations,
      visited
    );
  }

  if (utilityTypeName === "ThisParameterType") {
    return ambientThisParameterTypeUtility(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
    );
  }

  if (utilityTypeName === "OmitThisParameter") {
    return ambientOmitThisParameterUtility(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
    );
  }

  if (utilityTypeName === "Awaited") {
    return ambientAwaitedUtilityType(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
    );
  }

  if (utilityTypeName === "NoInfer" || utilityTypeName === "ThisType") {
    return typeFromAmbientAnnotationText(
      typeArguments[0],
      declarations,
      ambientModuleDeclarations,
      ambientGlobalDeclarations,
      visited
    );
  }

  if (utilityTypeName === "Uppercase") {
    return ambientStringTransformUtilityType(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited),
      (value) => value.toUpperCase()
    );
  }

  if (utilityTypeName === "Lowercase") {
    return ambientStringTransformUtilityType(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited),
      (value) => value.toLowerCase()
    );
  }

  if (utilityTypeName === "Capitalize") {
    return ambientStringTransformUtilityType(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited),
      (value) => value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
    );
  }

  if (utilityTypeName === "Uncapitalize") {
    return ambientStringTransformUtilityType(
      typeFromAmbientAnnotationText(typeArguments[0], declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited),
      (value) => value.length === 0 ? value : value[0]!.toLowerCase() + value.slice(1)
    );
  }

  const sourceType = typeFromAmbientAnnotationText(
    typeArguments[0],
    declarations,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  );
  const sourceProperties = ambientObjectProperties(sourceType);
  if (!sourceProperties) {
    return null;
  }

  if (utilityTypeName === "Partial") {
    return objectTypeWithProperties(
      Object.fromEntries(
        Object.entries(sourceProperties).map(([name, type]) => [name, ambientPropertyTypeWithUndefined(type)])
      )
    );
  }

  if (utilityTypeName === "Required") {
    return objectTypeWithProperties(
      Object.fromEntries(
        Object.entries(sourceProperties).map(([name, type]) => [name, ambientPropertyTypeWithoutUndefined(type)])
      )
    );
  }

  if (utilityTypeName === "Readonly") {
    return objectTypeWithProperties(sourceProperties);
  }

  if (typeArguments.length < 2) {
    return utilityTypeName === "WithRequired"
      ? objectTypeWithProperties(
          Object.fromEntries(
            Object.entries(sourceProperties).map(([name, type]) => [name, ambientPropertyTypeWithoutUndefined(type)])
          )
        )
      : null;
  }

  const selectedKeys = new Set(
    ambientStringLiteralKeys(
      typeFromAmbientAnnotationText(
        typeArguments[1],
        declarations,
        ambientModuleDeclarations,
        ambientGlobalDeclarations,
        visited
      )
    )
  );

  if (utilityTypeName === "WithRequired") {
    return objectTypeWithProperties(
      Object.fromEntries(
        Object.entries(sourceProperties).map(([name, type]) => [
          name,
          selectedKeys.has(name) ? ambientPropertyTypeWithoutUndefined(type) : type
        ])
      )
    );
  }

  if (utilityTypeName === "OmitKeyof" || utilityTypeName === "Omit") {
    const nextProperties = Object.fromEntries(
      Object.entries(sourceProperties).filter(([name]) => !selectedKeys.has(name))
    );
    return objectTypeWithProperties(nextProperties);
  }

  if (utilityTypeName === "Pick") {
    const nextProperties = Object.fromEntries(
      Object.entries(sourceProperties).filter(([name]) => selectedKeys.has(name))
    );
    return objectTypeWithProperties(nextProperties);
  }

  return null;
}

function ambientTypeAssignableForUtility(sourceType: AnalysisType, targetType: AnalysisType): boolean {
  if (typeToString(sourceType) === typeToString(targetType)) {
    return true;
  }
  if (targetType.kind === AnalysisTypeKind.Builtin && targetType.name === "any") {
    return true;
  }
  if (sourceType.kind === AnalysisTypeKind.Builtin && sourceType.name === "never") {
    return true;
  }
  if (targetType.kind === AnalysisTypeKind.Builtin && targetType.name === "unknown") {
    return true;
  }
  if (targetType.kind === AnalysisTypeKind.Union) {
    return targetType.types.some((member) => ambientTypeAssignableForUtility(sourceType, member));
  }
  if (sourceType.kind === AnalysisTypeKind.Union) {
    return sourceType.types.every((member) => ambientTypeAssignableForUtility(member, targetType));
  }
  if (sourceType.kind === AnalysisTypeKind.Literal) {
    if (targetType.kind === AnalysisTypeKind.Literal) {
      return sourceType.base === targetType.base && sourceType.value === targetType.value;
    }
    if (targetType.kind === AnalysisTypeKind.Builtin && targetType.name === sourceType.base) {
      return true;
    }
    if (
      targetType.kind === AnalysisTypeKind.Builtin &&
      targetType.name === "int" &&
      sourceType.base === "number" &&
      Number.isInteger(sourceType.value)
    ) {
      return true;
    }
  }
  if (sourceType.kind === AnalysisTypeKind.Named && targetType.kind === AnalysisTypeKind.Named) {
    return sourceType.name === targetType.name;
  }
  return false;
}

function ambientFilterUtilityType(sourceType: AnalysisType, targetType: AnalysisType, keepAssignable: boolean): AnalysisType {
  if (sourceType.kind === AnalysisTypeKind.Union) {
    const filtered = sourceType.types.filter((member) => ambientTypeAssignableForUtility(member, targetType) === keepAssignable);
    return combineTypes(filtered.length > 0 ? filtered : [builtinType("never")]);
  }
  return ambientTypeAssignableForUtility(sourceType, targetType) === keepAssignable
    ? sourceType
    : builtinType("never");
}

function ambientNonNullableUtilityType(sourceType: AnalysisType): AnalysisType {
  if (sourceType.kind === AnalysisTypeKind.Builtin && (sourceType.name === "null" || sourceType.name === "undefined")) {
    return builtinType("never");
  }
  return removeNullishFromType(sourceType);
}

function ambientRecordUtilityType(keyType: AnalysisType, valueType: AnalysisType): AnalysisType {
  const properties: Record<string, AnalysisType> = {};
  for (const key of ambientStringLiteralKeys(keyType)) {
    properties[key] = valueType;
  }
  if (keyType.kind === AnalysisTypeKind.Builtin && (keyType.name === "string" || keyType.name === "number" || keyType.name === "symbol")) {
    properties[`[${keyType.name}]`] = valueType;
  }
  if (keyType.kind === AnalysisTypeKind.Union) {
    for (const member of keyType.types) {
      if (member.kind === AnalysisTypeKind.Builtin && (member.name === "string" || member.name === "number" || member.name === "symbol")) {
        properties[`[${member.name}]`] = valueType;
      }
    }
  }
  return objectTypeWithProperties(properties);
}

function ambientReturnTypeUtility(sourceType: AnalysisType): AnalysisType | null {
  if (sourceType.kind === AnalysisTypeKind.Function) {
    return sourceType.returnType;
  }
  if (sourceType.kind === AnalysisTypeKind.Union) {
    const returnTypes = sourceType.types
      .filter((member): member is AnalysisType & { kind: AnalysisTypeKind.Function } => member.kind === AnalysisTypeKind.Function)
      .map((member) => member.returnType);
    return returnTypes.length > 0 ? combineTypes(returnTypes) : null;
  }
  return null;
}

function ambientParametersUtility(sourceType: AnalysisType): AnalysisType | null {
  if (sourceType.kind === AnalysisTypeKind.Function) {
    return tupleType(sourceType.parameters.map((parameter) => parameter.type));
  }
  if (sourceType.kind === AnalysisTypeKind.Union) {
    const tuples = sourceType.types
      .filter((member): member is AnalysisType & { kind: AnalysisTypeKind.Function } => member.kind === AnalysisTypeKind.Function)
      .map((member) => tupleType(member.parameters.map((parameter) => parameter.type)));
    return tuples.length > 0 ? combineTypes(tuples) : null;
  }
  return null;
}

function ambientAwaitedUtilityType(sourceType: AnalysisType): AnalysisType {
  if (sourceType.kind === AnalysisTypeKind.Union) {
    return combineTypes(sourceType.types.map((member) => ambientAwaitedUtilityType(member)));
  }
  if (sourceType.kind === AnalysisTypeKind.Builtin && (sourceType.name === "any" || sourceType.name === "unknown" || sourceType.name === "null" || sourceType.name === "undefined")) {
    return sourceType;
  }
  const unwrapped = unwrapPromiseType(sourceType)
    ?? (sourceType.kind === AnalysisTypeKind.Named && sourceType.name === "PromiseLike" ? sourceType.typeArguments?.[0] ?? UNKNOWN_TYPE : null);
  return unwrapped ? ambientAwaitedUtilityType(unwrapped) : sourceType;
}

function ambientStringTransformUtilityType(
  sourceType: AnalysisType,
  transform: (value: string) => string
): AnalysisType | null {
  if (sourceType.kind === AnalysisTypeKind.Literal && sourceType.base === "string") {
    return literalType("string", transform(String(sourceType.value)));
  }
  if (sourceType.kind === AnalysisTypeKind.Builtin && sourceType.name === "string") {
    return builtinType("string");
  }
  if (sourceType.kind === AnalysisTypeKind.Union) {
    const members = sourceType.types
      .map((member) => ambientStringTransformUtilityType(member, transform))
      .filter((member): member is AnalysisType => member !== null);
    return members.length > 0 ? combineTypes(members) : null;
  }
  return null;
}

function ambientConstructorParametersUtility(
  sourceType: AnalysisType,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType | null {
  const constructorType = ambientConstructSignatureForUtility(
    sourceType,
    declarations,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  );
  return constructorType
    ? tupleType(constructorType.parameters.map((parameter) => parameter.type))
    : null;
}

function ambientInstanceTypeUtility(
  sourceType: AnalysisType,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType | null {
  return ambientConstructSignatureForUtility(
    sourceType,
    declarations,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  )?.returnType ?? null;
}

function ambientThisParameterTypeUtility(sourceType: AnalysisType): AnalysisType {
  if (sourceType.kind === AnalysisTypeKind.Union) {
    return combineTypes(sourceType.types.map((member) => ambientThisParameterTypeUtility(member)));
  }
  if (sourceType.kind !== AnalysisTypeKind.Function) {
    return UNKNOWN_TYPE;
  }
  return sourceType.parameters[0]?.name === "this"
    ? sourceType.parameters[0]!.type
    : UNKNOWN_TYPE;
}

function ambientOmitThisParameterUtility(sourceType: AnalysisType): AnalysisType | null {
  if (sourceType.kind === AnalysisTypeKind.Union) {
    const members = sourceType.types
      .map((member) => ambientOmitThisParameterUtility(member))
      .filter((member): member is AnalysisType => member !== null);
    return members.length > 0 ? combineTypes(members) : null;
  }
  if (sourceType.kind !== AnalysisTypeKind.Function) {
    return null;
  }
  if (sourceType.parameters[0]?.name !== "this") {
    return sourceType;
  }
  return functionType(
    sourceType.parameters.slice(1),
    sourceType.returnType,
    sourceType.typeParameters,
    undefined,
    undefined,
    sourceType.assertion
  );
}

function ambientConstructSignatureForUtility(
  sourceType: AnalysisType,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): FunctionType | null {
  if (sourceType.kind === AnalysisTypeKind.Named) {
    const classStatement =
      findAmbientClassStatement(declarations, sourceType.name)
      ?? findAmbientClassStatement(ambientGlobalDeclarations, sourceType.name);
    if (!classStatement) {
      return null;
    }
    const constructorMember = classStatement.members.find(
      (member): member is ClassStatement["members"][number] & { kind: NodeKind.ClassMethodMember } =>
        member.kind === NodeKind.ClassMethodMember && member.name.name === "constructor"
    );
    const parameters = constructorMember
      ? constructorMember.parameters
          .filter((parameter) => parameter.thisParameter !== true)
          .map((parameter) => ({
            name: parameter.name,
            typeAnnotation: parameter.typeAnnotation,
            optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
            rest: parameter.rest === true
          }))
      : (classStatement.primaryConstructorParameters ?? []).map((parameter) => ({
          name: parameter.name,
          typeAnnotation: parameter.typeAnnotation,
          optional: parameter.defaultValue !== undefined,
          rest: false
        }));
    return functionType(
      parameters.map((parameter) => {
        const rawType = typeFromAmbientAnnotationText(
          parameter.typeAnnotation?.name,
          declarations,
          ambientModuleDeclarations,
          ambientGlobalDeclarations,
          visited
        );
        const isRest = parameter.rest === true;
        return {
          name: parameter.name.kind === NodeKind.Identifier ? parameter.name.name : "arg",
          type: isRest && rawType.kind === AnalysisTypeKind.Array ? (rawType as ArrayType).elementType : rawType,
          optional: parameter.optional === true || isRest,
          rest: isRest
        };
      }),
      namedType(classStatement.name.name)
    );
  }
  if (sourceType.kind === AnalysisTypeKind.Function) {
    return sourceType;
  }
  if (sourceType.kind === AnalysisTypeKind.Object) {
    const constructorType = sourceType.properties.get("constructor");
    return constructorType?.kind === AnalysisTypeKind.Function ? constructorType : null;
  }
  if (sourceType.kind === AnalysisTypeKind.Union) {
    for (const member of sourceType.types) {
      const constructorType = ambientConstructSignatureForUtility(
        member,
        declarations,
        ambientModuleDeclarations,
        ambientGlobalDeclarations,
        visited
      );
      if (constructorType) {
        return constructorType;
      }
    }
  }
  return null;
}

function findAmbientClassStatement(
  declarations: readonly Statement[],
  name: string
): ClassStatement | null {
  for (const statement of declarations) {
    const declaration = unwrapExportedDeclaration(statement) ?? statement;
    if (declaration.kind === NodeKind.ClassStatement && (declaration as ClassStatement).name.name === name) {
      return declaration as ClassStatement;
    }
  }
  return null;
}

function hasAmbientNamedTypeDeclaration(
  declarations: readonly Statement[],
  typeName: string
): boolean {
  for (const statement of declarations) {
    const declaration = unwrapExportedDeclaration(statement) ?? statement;
    if (
      (declaration.kind === NodeKind.ClassStatement ||
        declaration.kind === NodeKind.InterfaceStatement ||
        declaration.kind === NodeKind.EnumStatement) &&
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
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType | null {
  for (const declarations of ambientModuleCandidates(moduleName, ambientModuleDeclarations)) {
    const local = typeFromAmbientAnnotationText(
      typeName,
      declarations,
      ambientModuleDeclarations,
      ambientGlobalDeclarations,
      visited
    );
    if (local.kind !== AnalysisTypeKind.Named || local.name !== typeName || (local.typeArguments?.length ?? 0) > 0) {
      return local;
    }
    if (hasAmbientNamedTypeDeclaration(declarations, typeName)) {
      return local;
    }

    const exportEqualsName = detectAmbientExportEqualsName(declarations);
    if (!exportEqualsName) {
      continue;
    }
    const namespaceBody = findAmbientNamespaceBody(declarations, exportEqualsName);
    if (!namespaceBody) {
      continue;
    }
    const fromNamespace = typeFromAmbientAnnotationText(
      typeName,
      namespaceBody,
      ambientModuleDeclarations,
      ambientGlobalDeclarations,
      visited
    );
    if (
      fromNamespace.kind !== AnalysisTypeKind.Named
      || fromNamespace.name !== typeName
      || (fromNamespace.typeArguments?.length ?? 0) > 0
    ) {
      return fromNamespace;
    }
    if (hasAmbientNamedTypeDeclaration(namespaceBody, typeName)) {
      return fromNamespace;
    }
  }
  return null;
}

function typeFromAmbientAnnotationText(
  typeName: string | undefined,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[] = [],
  visited: Set<string> = new Set()
): AnalysisType {
  if (!typeName) {
    return UNKNOWN_TYPE;
  }
  const normalized = stripEnclosingTypeParens(typeName.trim());
  const importedType = resolveAmbientImportTypeReference(
    normalized,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  );
  if (importedType) {
    return importedType;
  }
  if (normalized === "unique symbol") {
    return builtinType("symbol");
  }
  if (normalized.startsWith("asserts ")) {
    return builtinType("void");
  }
  const parsedFunctionType = parseFunctionTypeAnnotation(normalized);
  if (parsedFunctionType) {
    return functionType(
      parsedFunctionType.parameters.map((parameter) => ({
        name: parameter.name,
        type: typeFromAmbientAnnotationText(
          parameter.typeName,
          declarations,
          ambientModuleDeclarations,
          ambientGlobalDeclarations,
          visited
        ),
        ...(parameter.optional ? { optional: true } : {}),
        ...(parameter.rest ? { rest: true } : {})
      })),
      typeFromAmbientAnnotationText(
        parsedFunctionType.returnTypeName,
        declarations,
        ambientModuleDeclarations,
        ambientGlobalDeclarations,
        visited
      ),
      parsedFunctionType.typeParameters,
      parsedFunctionType.typeParameterConstraints
        ? Object.fromEntries(
            Object.entries(parsedFunctionType.typeParameterConstraints).map(([name, constraintTypeName]) => [
              name,
              typeFromAmbientAnnotationText(
                constraintTypeName,
                declarations,
                ambientModuleDeclarations,
                ambientGlobalDeclarations,
                visited
              )
            ])
          )
        : undefined,
      parsedFunctionType.typeParameterDefaults
        ? Object.fromEntries(
            Object.entries(parsedFunctionType.typeParameterDefaults).map(([name, defaultTypeName]) => [
              name,
              typeFromAmbientAnnotationText(
                defaultTypeName,
                declarations,
                ambientModuleDeclarations,
                ambientGlobalDeclarations,
                visited
              )
            ])
          )
        : undefined,
      importedAssertionTypeFromText(
        parsedFunctionType.returnTypeName,
        declarations,
        new Set(),
        ambientModuleDeclarations,
        ambientGlobalDeclarations,
        visited
      )
    );
  }
  const unionParts = splitTopLevelTypeText(normalized, "|");
  if (unionParts.length > 1) {
    return unionType(unionParts.map((part) =>
      typeFromAmbientAnnotationText(part, declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
    ));
  }
  const intersectionParts = splitTopLevelTypeText(normalized, "&");
  if (intersectionParts.length > 1) {
    return intersectionType(intersectionParts.map((part) =>
      typeFromAmbientAnnotationText(part, declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
    ));
  }
  const objectType = objectTypeFromAmbientAnnotationText(
    normalized,
    declarations,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  );
  if (objectType) {
    return objectType;
  }
  const readonlyContainer = parseReadonlyContainerTypeText(normalized);
  if (readonlyContainer?.kind === "tuple") {
    return tupleType(
      (readonlyContainer.tupleElementTypeTexts ?? []).map((part) =>
        typeFromAmbientAnnotationText(part, declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
      ),
      true
    );
  }
  if (readonlyContainer?.kind === "array" && readonlyContainer.elementTypeText) {
    return arrayType(
      typeFromAmbientAnnotationText(
        readonlyContainer.elementTypeText,
        declarations,
        ambientModuleDeclarations,
        ambientGlobalDeclarations,
        visited
      ),
      true
    );
  }
  if (
    (normalized.startsWith("\"") && normalized.endsWith("\""))
    || (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    return literalType("string", normalized.slice(1, -1));
  }
  if (normalized === "true") {
    return literalType("boolean", true);
  }
  if (normalized === "false") {
    return literalType("boolean", false);
  }
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(normalized)) {
    return literalType("number", Number(normalized));
  }
  const templateLiteralType = ambientTemplateLiteralTypeFromText(
    normalized,
    declarations,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  );
  if (templateLiteralType) {
    return templateLiteralType;
  }

  const indexedAccess = parseAmbientIndexedAccess(normalized);
  if (indexedAccess) {
    const baseType = typeFromAmbientAnnotationText(
      indexedAccess.baseTypeName,
      declarations,
      ambientModuleDeclarations,
      ambientGlobalDeclarations,
      visited
    );
    const baseProperties = ambientObjectProperties(baseType);
    if (baseProperties) {
      const keyType = typeFromAmbientAnnotationText(
        indexedAccess.indexTypeName,
        declarations,
        ambientModuleDeclarations,
        ambientGlobalDeclarations,
        visited
      );
      const resolvedMembers = ambientStringLiteralKeys(keyType)
        .map((keyName) => baseProperties[keyName])
        .filter((memberType): memberType is AnalysisType => memberType != null);
      if (resolvedMembers.length > 0) {
        return unionIfNeeded(resolvedMembers);
      }
    }
  }

  const conditionalType = ambientConditionalTypeFromText(
    normalized,
    declarations,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  );
  if (conditionalType) {
    return conditionalType;
  }

  const parsed = parseTypeNameShape(normalized);
  const resolvedTypeArguments = parsed.typeArguments.map((argument) =>
    typeFromAmbientAnnotationText(argument, declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
  );
  let resolvedBase: AnalysisType;

  if (BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
    resolvedBase = builtinType(parsed.baseName as Parameters<typeof builtinType>[0]);
  } else {
    const utilityType = applyAmbientUtilityType(
      parsed.baseName,
      parsed.typeArguments,
      declarations,
      ambientModuleDeclarations,
      ambientGlobalDeclarations,
      visited
    );
    if (utilityType) {
      resolvedBase = utilityType;
      let resolved: AnalysisType = resolvedBase;
      for (let depth = 0; depth < parsed.arrayDepth; depth += 1) {
        resolved = arrayType(resolved);
      }
      return resolved;
    }

    const qualifiedImportedType = resolveAmbientQualifiedImportedType(
      parsed.baseName,
      declarations,
      ambientModuleDeclarations,
      ambientGlobalDeclarations,
      visited
    );
    if (qualifiedImportedType) {
      resolvedBase = qualifiedImportedType;
      let resolved: AnalysisType = resolvedBase.kind === AnalysisTypeKind.Named && resolvedTypeArguments.length > 0
        ? namedType(resolvedBase.name, resolvedTypeArguments)
        : resolvedBase;
      for (let depth = 0; depth < parsed.arrayDepth; depth += 1) {
        resolved = arrayType(resolved);
      }
      return resolved;
    }

    const visitKey = parsed.baseName;
    const typeAlias = findAmbientTypeAliasStatement(declarations, parsed.baseName);
    if (typeAlias && !visited.has(visitKey)) {
      visited.add(visitKey);
      resolvedBase = typeFromAmbientAnnotationText(
        typeAlias.targetType.name,
        declarations,
        ambientModuleDeclarations,
        ambientGlobalDeclarations,
        visited
      );
      visited.delete(visitKey);
    } else {
      const interfaceStatement = findAmbientInterfaceStatement(declarations, parsed.baseName);
      if (interfaceStatement && !visited.has(visitKey)) {
        visited.add(visitKey);
        resolvedBase = objectTypeFromAmbientInterfaceStatement(
          interfaceStatement,
          declarations,
          ambientModuleDeclarations,
          ambientGlobalDeclarations,
          visited
        );
        visited.delete(visitKey);
      } else {
        const globalTypeAlias = findAmbientTypeAliasStatement(ambientGlobalDeclarations, parsed.baseName);
        if (globalTypeAlias && !visited.has(`global:${visitKey}`)) {
          visited.add(`global:${visitKey}`);
          resolvedBase = typeFromAmbientAnnotationText(
            globalTypeAlias.targetType.name,
            ambientGlobalDeclarations,
            ambientModuleDeclarations,
            ambientGlobalDeclarations,
            visited
          );
          visited.delete(`global:${visitKey}`);
        } else {
          const globalInterfaceStatement = findAmbientInterfaceStatement(ambientGlobalDeclarations, parsed.baseName);
          if (globalInterfaceStatement && !visited.has(`global:${visitKey}`)) {
            visited.add(`global:${visitKey}`);
            resolvedBase = objectTypeFromAmbientInterfaceStatement(
              globalInterfaceStatement,
              ambientGlobalDeclarations,
              ambientModuleDeclarations,
              ambientGlobalDeclarations,
              visited
            );
            visited.delete(`global:${visitKey}`);
          } else {
            const importedReference = findImportBindingByLocalName(declarations, parsed.baseName);
            if (importedReference) {
              resolvedBase = resolveAmbientTypeReference(
                importedReference.from,
                importedReference.importedName,
                ambientModuleDeclarations,
                ambientGlobalDeclarations,
                visited
              ) ?? builtinType("object");
            } else {
              resolvedBase = namedType(parsed.baseName, resolvedTypeArguments);
            }
          }
        }
      }
    }
  }

  let resolved: AnalysisType = resolvedBase.kind === AnalysisTypeKind.Named && resolvedTypeArguments.length > 0
    ? namedType(resolvedBase.name, resolvedTypeArguments)
    : resolvedBase;
  for (let depth = 0; depth < parsed.arrayDepth; depth += 1) {
    resolved = arrayType(resolved);
  }
  return resolved;
}

function ambientTemplateLiteralTypeFromText(
  typeName: string,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType | null {
  const segments = parseTemplateLiteralTypeText(typeName);
  if (!segments) {
    return null;
  }

  let variants = [""];
  for (const segment of segments) {
    if (segment.kind === "text") {
      variants = variants.map((variant) => variant + segment.value);
      continue;
    }

    const placeholderValues = ambientStringifiableTemplateLiteralValues(
      typeFromAmbientAnnotationText(
        segment.value,
        declarations,
        ambientModuleDeclarations,
        ambientGlobalDeclarations,
        visited
      )
    );
    if (!placeholderValues) {
      return builtinType("string");
    }

    const nextVariants: string[] = [];
    for (const variant of variants) {
      for (const placeholderValue of placeholderValues) {
        nextVariants.push(variant + placeholderValue);
      }
    }
    variants = nextVariants;
  }

  return unionIfNeeded(variants.map((variant) => literalType("string", variant)));
}

function ambientStringifiableTemplateLiteralValues(type: AnalysisType): string[] | null {
  if (type.kind === AnalysisTypeKind.Literal) {
    return [String(type.value)];
  }
  if (type.kind === AnalysisTypeKind.Union) {
    const values: string[] = [];
    for (const member of type.types) {
      const memberValues = ambientStringifiableTemplateLiteralValues(member);
      if (!memberValues) {
        return null;
      }
      values.push(...memberValues);
    }
    return values;
  }
  if (type.kind === AnalysisTypeKind.Builtin && (type.name === "string" || type.name === "number" || type.name === "boolean" || type.name === "bigint" || type.name === "long")) {
    return null;
  }
  return null;
}

function ambientConditionalTypeFromText(
  typeName: string,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType | null {
  const conditional = parseConditionalTypeText(typeName);
  if (!conditional) {
    return null;
  }

  const distributiveSource = ambientDistributiveConditionalSourceType(
    conditional.checkTypeText.trim(),
    declarations,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  );
  if (distributiveSource?.kind === AnalysisTypeKind.Union) {
    return combineTypes(distributiveSource.types.map((member) =>
      ambientResolveConditionalBranch(
        conditional,
        member,
        new Map([[conditional.checkTypeText.trim(), member]]),
        declarations,
        ambientModuleDeclarations,
        ambientGlobalDeclarations,
        visited
      )
    ));
  }

  const checkType = typeFromAmbientAnnotationText(
    conditional.checkTypeText,
    declarations,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  );
  return ambientResolveConditionalBranch(
    conditional,
    checkType,
    new Map(),
    declarations,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  );
}

function ambientResolveConditionalBranch(
  conditional: NonNullable<ReturnType<typeof parseConditionalTypeText>>,
  checkType: AnalysisType,
  substitutions: Map<string, AnalysisType>,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType {
  const inferSubstitutions = ambientInferConditionalPatternSubstitutions(checkType, substituteAmbientTypeNames(conditional.extendsTypeText, substitutions));
  const selectedBranch = inferSubstitutions
    ? substituteAmbientTypeNames(conditional.trueTypeText, inferSubstitutions)
    : ambientTypeAssignableForUtility(
      checkType,
      typeFromAmbientAnnotationText(
        substituteAmbientTypeNames(conditional.extendsTypeText, substitutions),
        declarations,
        ambientModuleDeclarations,
        ambientGlobalDeclarations,
        visited
      )
    )
      ? conditional.trueTypeText
      : conditional.falseTypeText;

  const finalSubstitutions = new Map(substitutions);
  if (inferSubstitutions) {
    for (const [name, type] of inferSubstitutions.entries()) {
      finalSubstitutions.set(name, type);
    }
  }
  const substitutedBranch = substituteAmbientTypeNames(selectedBranch, finalSubstitutions);
  return ambientConditionalTypeFromText(
    substitutedBranch,
    declarations,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  ) ?? typeFromAmbientAnnotationText(
    substitutedBranch,
    declarations,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  );
}

function ambientDistributiveConditionalSourceType(
  checkTypeText: string,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(checkTypeText)) {
    return null;
  }
  return typeFromAmbientAnnotationText(
    checkTypeText,
    declarations,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  );
}

function ambientInferConditionalPatternSubstitutions(
  sourceType: AnalysisType,
  patternText: string
): Map<string, AnalysisType> | null {
  const trimmed = patternText.trim();
  const directInferMatch = /^infer\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+(.+))?$/.exec(trimmed);
  if (directInferMatch?.[1]) {
    return ambientConstrainedInferSubstitution(
      directInferMatch[1],
      sourceType,
      directInferMatch[2]?.trim()
    );
  }
  const arrayMatch = /^\(?infer\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+(.+?))?\)?\[\]$/.exec(trimmed);
  if (arrayMatch?.[1]) {
    const elementType = ambientArrayElementTypeForInferPattern(sourceType);
    return elementType ? ambientConstrainedInferSubstitution(arrayMatch[1], elementType, arrayMatch[2]?.trim()) : null;
  }

  const genericInferMatch = /^([A-Za-z_$][\w$.]*)<\s*infer\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+(.+?))?\s*>$/.exec(trimmed);
  if (genericInferMatch?.[1] && genericInferMatch[2]) {
    const inferred = ambientGenericInferTypeArgument(sourceType, genericInferMatch[1]);
    return inferred ? ambientConstrainedInferSubstitution(genericInferMatch[2], inferred, genericInferMatch[3]?.trim()) : null;
  }

  const functionArgsInferMatch = /^\(\s*\.\.\.[^:]+:\s*infer\s+([A-Za-z_$][\w$]*)\s*\)\s*=>\s*any$/.exec(trimmed);
  if (functionArgsInferMatch?.[1] && sourceType.kind === AnalysisTypeKind.Function) {
    return new Map([[functionArgsInferMatch[1], tupleType(sourceType.parameters.map((parameter) => parameter.type))]]);
  }

  const functionReturnInferMatch = /^\(\s*\.\.\.[^:]+:\s*any\s*\)\s*=>\s*infer\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (functionReturnInferMatch?.[1] && sourceType.kind === AnalysisTypeKind.Function) {
    return new Map([[functionReturnInferMatch[1], sourceType.returnType]]);
  }

  const functionInferMatch = parseFunctionTypeAnnotation(trimmed);
  if (functionInferMatch && sourceType.kind === AnalysisTypeKind.Function) {
    const result = new Map<string, AnalysisType>();
    if (functionInferMatch.parameters.length === 1 && functionInferMatch.parameters[0]?.rest === true) {
      const parameterTypeName = functionInferMatch.parameters[0].typeName.trim();
      const restInferMatch = /^infer\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+(.+))?$/.exec(parameterTypeName);
      if (restInferMatch?.[1]) {
        const constrained = ambientConstrainedInferSubstitution(
          restInferMatch[1],
          tupleType(sourceType.parameters.map((parameter) => parameter.type)),
          restInferMatch[2]?.trim()
        );
        if (!constrained) {
          return null;
        }
        for (const [name, type] of constrained.entries()) {
          result.set(name, type);
        }
      } else if (parameterTypeName !== "any") {
        return null;
      }
    }
    const returnInferMatch = /^infer\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+(.+))?$/.exec(functionInferMatch.returnTypeName.trim());
    if (returnInferMatch?.[1]) {
      const constrained = ambientConstrainedInferSubstitution(
        returnInferMatch[1],
        sourceType.returnType,
        returnInferMatch[2]?.trim()
      );
      if (!constrained) {
        return null;
      }
      for (const [name, type] of constrained.entries()) {
        result.set(name, type);
      }
    } else if (functionInferMatch.returnTypeName.trim() !== "any") {
      return null;
    }
    return result.size > 0 ? result : null;
  }

  const constructorParamsMatch = /^(?:abstract\s+)?new\s*\(\s*\.\.\.[^:]+:\s*infer\s+([A-Za-z_$][\w$]*)\s*\)\s*=>\s*any$/.exec(trimmed);
  if (constructorParamsMatch?.[1]) {
    const constructorType = sourceType.kind === AnalysisTypeKind.Function ? sourceType : null;
    return constructorType
      ? new Map([[constructorParamsMatch[1], tupleType(constructorType.parameters.map((parameter) => parameter.type))]])
      : null;
  }

  const constructorReturnMatch = /^(?:abstract\s+)?new\s*\(\s*\.\.\.[^:]+:\s*any\s*\)\s*=>\s*infer\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (constructorReturnMatch?.[1]) {
    const constructorType = sourceType.kind === AnalysisTypeKind.Function ? sourceType : null;
    return constructorType
      ? new Map([[constructorReturnMatch[1], constructorType.returnType]])
      : null;
  }

  return null;
}

function ambientConstrainedInferSubstitution(
  name: string,
  inferredType: AnalysisType,
  constraintText?: string
): Map<string, AnalysisType> | null {
  if (constraintText) {
    const constraintType = typeFromAnnotationText(constraintText);
    if (!ambientTypeAssignableForUtility(inferredType, constraintType)) {
      return null;
    }
  }
  return new Map([[name, inferredType]]);
}

function ambientArrayElementTypeForInferPattern(sourceType: AnalysisType): AnalysisType | null {
  if (sourceType.kind === AnalysisTypeKind.Array) {
    return sourceType.elementType;
  }
  if (sourceType.kind === AnalysisTypeKind.Tuple) {
    return sourceType.elements.length === 1 ? sourceType.elements[0]! : unionIfNeeded(sourceType.elements);
  }
  if (sourceType.kind === AnalysisTypeKind.Named && (sourceType.name === "Array" || sourceType.name === "ReadonlyArray")) {
    return sourceType.typeArguments?.[0] ?? UNKNOWN_TYPE;
  }
  return null;
}

function ambientGenericInferTypeArgument(sourceType: AnalysisType, genericName: string): AnalysisType | null {
  if (sourceType.kind === AnalysisTypeKind.Array && (genericName === "Array" || genericName === "ReadonlyArray")) {
    return sourceType.elementType;
  }
  if (sourceType.kind === AnalysisTypeKind.Tuple && (genericName === "Array" || genericName === "ReadonlyArray")) {
    return sourceType.elements.length === 1 ? sourceType.elements[0]! : unionIfNeeded(sourceType.elements);
  }
  if (sourceType.kind !== AnalysisTypeKind.Named || sourceType.name !== genericName) {
    return null;
  }
  return sourceType.typeArguments?.[0] ?? UNKNOWN_TYPE;
}

function substituteAmbientTypeNames(typeName: string, substitutions: Map<string, AnalysisType>): string {
  let result = typeName;
  for (const [name, substitution] of substitutions.entries()) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`\\b${escapedName}\\b`, "g"), typeToString(substitution));
  }
  return result;
}

function buildAmbientFunctionTypeFromStatement(
  fn: FunctionStatement,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[] = []
): AnalysisType {
  return functionType(
    mapFunctionParameters(
      fn.parameters,
      (name) => typeFromAmbientAnnotationText(name, declarations, ambientModuleDeclarations, ambientGlobalDeclarations)
    ),
    typeFromAmbientAnnotationText(fn.returnType?.name, declarations, ambientModuleDeclarations, ambientGlobalDeclarations),
    fn.typeParameters?.map((tp) => tp.name.name),
    undefined,
    undefined,
    importedAssertionTypeFromText(
      fn.returnType?.name,
      declarations,
      new Set(),
      ambientModuleDeclarations,
      ambientGlobalDeclarations
    )
  );
}

function buildAmbientFunctionTypeFromInterfaceMember(
  member: InterfaceMethodMember,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType {
  return functionType(
    mapFunctionParameters(
      member.parameters,
      (name) => typeFromAmbientAnnotationText(name, declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
    ),
    typeFromAmbientAnnotationText(
      member.returnType?.name,
      declarations,
      ambientModuleDeclarations,
      ambientGlobalDeclarations,
      visited
    ),
    undefined,
    undefined,
    undefined,
    importedAssertionTypeFromText(
      member.returnType?.name,
      declarations,
      new Set(),
      ambientModuleDeclarations,
      ambientGlobalDeclarations,
      visited
    )
  );
}

function typeFromAmbientInterfaceMember(
  member: InterfaceMember,
  declarations: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[],
  visited: Set<string>
): AnalysisType {
  if (member.kind === NodeKind.InterfaceMethodMember) {
    return buildAmbientFunctionTypeFromInterfaceMember(
      member as InterfaceMethodMember,
      declarations,
      ambientModuleDeclarations,
      ambientGlobalDeclarations,
      visited
    );
  }
  return typeFromAmbientAnnotationText(
    member.typeAnnotation?.name,
    declarations,
    ambientModuleDeclarations,
    ambientGlobalDeclarations,
    visited
  );
}

function extractDirectTypeForName(stmts: Statement[], symbolName: string): AnalysisType | null {
  for (const stmt of stmts) {
    const decl = unwrapExportedDeclaration(stmt) ?? stmt;

    if (decl.kind === NodeKind.FunctionStatement) {
      const fn = decl as FunctionStatement;
      if (fn.name?.name === symbolName) {
        return buildFunctionTypeFromStatement(fn);
      }
    }

    if (decl.kind === NodeKind.VarStatement) {
      const v = decl as VarStatement;
      const varName = v.name?.kind === NodeKind.Identifier ? (v.name as Identifier).name : null;
      if (varName === symbolName && (v as { typeAnnotation?: { name?: string } }).typeAnnotation?.name) {
        return typeFromAnnotationText((v as { typeAnnotation?: { name?: string } }).typeAnnotation?.name);
      }
    }

    if (
      decl.kind === NodeKind.ClassStatement ||
      decl.kind === NodeKind.InterfaceStatement ||
      decl.kind === NodeKind.EnumStatement ||
      decl.kind === NodeKind.TypeAliasStatement
    ) {
      const named = decl as unknown as { name: { name: string } };
      if (named.name?.name === symbolName) {
        return namedType(named.name.name);
      }
    }
  }
  return null;
}

function collectAmbientNamespaceExportedProperties(
  statements: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[]
): Record<string, AnalysisType> {
  const properties: Record<string, AnalysisType> = {};
  for (const statement of statements) {
    const declaration = unwrapExportedDeclaration(statement) ?? statement;

    if (statement.kind === NodeKind.ExportStatement) {
      const exportStatement = statement as ExportStatement;
      for (const specifier of exportStatement.specifiers ?? []) {
        const localName = specifier.local?.name ?? specifier.exported.name;
        if (localName === specifier.exported.name) {
          continue;
        }
        const resolved = resolveNodeModuleNamedImportType(statements, localName);
        if (resolved) {
          properties[specifier.exported.name] = resolved;
        }
      }
    }

    if (declaration.kind === NodeKind.FunctionStatement) {
      const fn = declaration as FunctionStatement;
      properties[fn.name.name] = buildAmbientFunctionTypeFromStatement(
        fn,
        statements,
        ambientModuleDeclarations,
        ambientGlobalDeclarations
      );
      continue;
    }
    if (declaration.kind === NodeKind.VarStatement) {
      const variable = declaration as VarStatement;
      const bindings = variable.declarations?.flatMap((item) => bindingIdentifiers(item.name)) ?? bindingIdentifiers(variable.name);
      for (const binding of bindings) {
        properties[binding.name] = typeFromAmbientAnnotationText(
          variable.typeAnnotation?.name,
          statements,
          ambientModuleDeclarations,
          ambientGlobalDeclarations
        );
      }
      continue;
    }
    if (declaration.kind === NodeKind.ClassStatement) {
      properties[(declaration as ClassStatement).name.name] = namedType((declaration as ClassStatement).name.name);
      continue;
    }
    if (declaration.kind === NodeKind.InterfaceStatement) {
      properties[(declaration as InterfaceStatement).name.name] = namedType((declaration as InterfaceStatement).name.name);
      continue;
    }
    if (declaration.kind === NodeKind.TypeAliasStatement) {
      properties[(declaration as TypeAliasStatement).name.name] = namedType((declaration as TypeAliasStatement).name.name);
      continue;
    }
    if (declaration.kind === NodeKind.NamespaceStatement) {
      const namespaceName = (declaration as NamespaceStatement).names?.[0]?.name;
      if (namespaceName) {
        properties[namespaceName] = namedType(namespaceName);
      }
    }
  }
  return properties;
}

function nodeModuleNamespaceStatementType(namespaceStatement: NamespaceStatement): AnalysisType {
  return objectTypeWithProperties(collectNodeModuleNamespaceExportedProperties(namespaceStatement.body.body));
}

function collectNodeModuleNamespaceExportedProperties(
  statements: readonly Statement[]
): Record<string, AnalysisType> {
  const resolutionCache = getNodeModuleResolutionCache(statements);
  if (resolutionCache.namespaceExportProperties) {
    return resolutionCache.namespaceExportProperties;
  }
  const properties: Record<string, AnalysisType> = {};
  const functionOverloads = new Map<string, FunctionType[]>();
  for (const statement of statements) {
    const declaration = unwrapExportedDeclaration(statement) ?? statement;

    if (statement.kind === NodeKind.ExportStatement) {
      const exportStatement = statement as ExportStatement;
      for (const specifier of exportStatement.specifiers ?? []) {
        const localName = specifier.local?.name ?? specifier.exported.name;
        if (localName === specifier.exported.name) {
          continue;
        }
        const resolved = resolveNodeModuleNamedImportType(statements, localName);
        if (resolved) {
          properties[specifier.exported.name] = resolved;
        }
      }
    }

    if (declaration.kind === NodeKind.FunctionStatement) {
      const fn = declaration as FunctionStatement;
      const overloads = functionOverloads.get(fn.name.name) ?? [];
      overloads.push(buildFunctionTypeFromStatement(fn) as FunctionType);
      functionOverloads.set(fn.name.name, overloads);
      continue;
    }
    if (declaration.kind === NodeKind.VarStatement) {
      const variable = declaration as VarStatement;
      const bindings = variable.declarations?.flatMap((item) => bindingIdentifiers(item.name)) ?? bindingIdentifiers(variable.name);
      for (const binding of bindings) {
        properties[binding.name] = typeFromAnnotationText(variable.typeAnnotation?.name, statements);
      }
      continue;
    }
    if (declaration.kind === NodeKind.ClassStatement) {
      properties[(declaration as ClassStatement).name.name] = namedType((declaration as ClassStatement).name.name);
      continue;
    }
    if (declaration.kind === NodeKind.InterfaceStatement) {
      properties[(declaration as InterfaceStatement).name.name] = namedType((declaration as InterfaceStatement).name.name);
      continue;
    }
    if (declaration.kind === NodeKind.EnumStatement) {
      properties[(declaration as EnumStatement).name.name] = namedType((declaration as EnumStatement).name.name);
      continue;
    }
    if (declaration.kind === NodeKind.TypeAliasStatement) {
      properties[(declaration as TypeAliasStatement).name.name] = namedType((declaration as TypeAliasStatement).name.name);
      continue;
    }
    if (declaration.kind === NodeKind.NamespaceStatement) {
      const namespace = declaration as NamespaceStatement;
      const namespaceName = namespace.names?.[0]?.name;
      if (namespaceName) {
        properties[namespaceName] = nodeModuleNamespaceStatementType(namespace);
      }
    }
  }
  for (const [name, overloads] of functionOverloads) {
    // Namespace-shaped object properties do not preserve call-site overload
    // resolution well. Prefer the first declared signature over widening to a
    // union-like collapsed callable that can degrade downstream inference.
    properties[name] = overloads[0]!;
  }
  resolutionCache.namespaceExportProperties = properties;
  return properties;
}

function resolveNodeModuleDefaultImportType(
  declarations: readonly Statement[],
  defaultExportName: string,
  resolvingImportTypes: Set<string> = new Set()
): AnalysisType {
  const resolutionCache = getNodeModuleResolutionCache(declarations);
  const cached = resolutionCache.defaultImportTypes.get(defaultExportName);
  if (cached) {
    return cached;
  }
  const exportType = namedType(defaultExportName);
  const callableExport = callableTypeFromExternalFunction(declarations, defaultExportName, resolvingImportTypes);
  const namespaceBody = findAmbientNamespaceBody(declarations, defaultExportName);
  if (namespaceBody) {
    const namespaceExports = collectNodeModuleNamespaceExportedProperties(namespaceBody);
    if (Object.keys(namespaceExports).length > 0) {
      const namespaceType = objectTypeWithProperties(namespaceExports);
      const resolved = callableExport
        ? intersectionType([callableExport, namespaceType])
        : namespaceType;
      resolutionCache.defaultImportTypes.set(defaultExportName, resolved);
      return resolved;
    }
  }
  const resolved = callableExport ?? exportType;
  resolutionCache.defaultImportTypes.set(defaultExportName, resolved);
  return resolved;
}

function resolveAmbientDefaultImportType(
  importName: string,
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[] = []
): AnalysisType | null {
  const resolutionCache = getAmbientModuleResolutionCache(ambientModuleDeclarations);
  const cached = resolutionCache.defaultImportTypes.get(importName);
  if (cached !== undefined) {
    return cached;
  }
  let fallbackNamedExport: AnalysisType | null = null;
  for (const decls of ambientModuleCandidates(importName, ambientModuleDeclarations)) {
    if (decls.length === 0) {
      continue;
    }

    const exportEqualsName = detectAmbientExportEqualsName(decls);

    for (const statement of decls) {
      if (statement.kind !== NodeKind.ExportStatement || !(statement as ExportStatement).isDefault) {
        continue;
      }
      const declaration = (statement as ExportStatement).declaration;
      if (declaration?.kind === NodeKind.FunctionStatement) {
        const resolved = buildAmbientFunctionTypeFromStatement(
          declaration as FunctionStatement,
          decls,
          ambientModuleDeclarations,
          ambientGlobalDeclarations
        );
        resolutionCache.defaultImportTypes.set(importName, resolved);
        return resolved;
      }
    }

    const directExports = collectAmbientNamespaceExportedProperties(
      decls,
      ambientModuleDeclarations,
      ambientGlobalDeclarations
    );
    const directExportKeys = Object.keys(directExports);
    const isExportEqualsNamespaceFacade =
      exportEqualsName !== null
      && directExportKeys.length === 1
      && directExportKeys[0] === exportEqualsName
      && findAmbientNamespaceBody(decls, exportEqualsName) !== null;
    if (directExportKeys.length > 0 && !isExportEqualsNamespaceFacade) {
      const resolved = objectTypeWithProperties(directExports);
      resolutionCache.defaultImportTypes.set(importName, resolved);
      return resolved;
    }

    if (!exportEqualsName) {
      continue;
    }

    const callableExport = extractDirectTypeForName([...decls], exportEqualsName);
    const namespaceBody = findAmbientNamespaceBody(decls, exportEqualsName);
    if (namespaceBody) {
      const namespaceExports = collectAmbientNamespaceExportedProperties(
        namespaceBody,
        ambientModuleDeclarations,
        ambientGlobalDeclarations
      );
      if (Object.keys(namespaceExports).length > 0) {
        return callableExport?.kind === AnalysisTypeKind.Function
          ? intersectionType([callableExport, objectTypeWithProperties(namespaceExports)])
          : objectTypeWithProperties(namespaceExports);
      }
    }

    for (const statement of decls) {
      if (statement.kind !== NodeKind.VarStatement) {
        continue;
      }
      const variable = statement as VarStatement;
      const varName = variable.name?.kind === NodeKind.Identifier ? (variable.name as Identifier).name : null;
      if (varName !== exportEqualsName) {
        continue;
      }
      const resolvedType = typeFromAmbientAnnotationText(
        variable.typeAnnotation?.name,
        decls,
        ambientModuleDeclarations,
        ambientGlobalDeclarations
      );
      if (resolvedType.kind !== AnalysisTypeKind.Unknown) {
        const resolved = callableExport?.kind === AnalysisTypeKind.Function
          ? intersectionType([callableExport, resolvedType])
          : resolvedType;
        resolutionCache.defaultImportTypes.set(importName, resolved);
        return resolved;
      }
    }

    if (callableExport) {
      resolutionCache.defaultImportTypes.set(importName, callableExport);
      return callableExport;
    }
    fallbackNamedExport ??= namedType(exportEqualsName);
  }
  resolutionCache.defaultImportTypes.set(importName, fallbackNamedExport);
  return fallbackNamedExport;
}

function ambientDefaultImportDisplayType(importName: string): string {
  return `typeof import("${importName}")`;
}

/**
 * Yields each ambient interface member named `symbolName` reached through an
 * `export = <name>` whose declared type points at `namespace.Interface`
 * (e.g. `const path: path.PlatformPath`). Shared by the type, display, and
 * has-export ambient resolvers so they search identically and differ only in
 * how they project each matched member.
 */
function* ambientExportEqualsInterfaceMembers(
  decls: readonly Statement[],
  exportEqualsName: string,
  symbolName: string
): Generator<{ member: InterfaceMember; searchNsBody: readonly Statement[] }> {
  for (const statement of decls) {
    if (statement.kind !== NodeKind.VarStatement) continue;
    const variable = statement as VarStatement;
    const varName = variable.name?.kind === NodeKind.Identifier ? (variable.name as Identifier).name : null;
    const typeName = variable.typeAnnotation?.name;
    if (varName !== exportEqualsName || !typeName) continue;

    // Parse "path.PlatformPath" → namespace "path", interface "PlatformPath"
    const dotIdx = typeName.lastIndexOf(".");
    const nsName = dotIdx > 0 ? typeName.slice(0, dotIdx) : null;
    const ifaceName = dotIdx > 0 ? typeName.slice(dotIdx + 1) : typeName;
    const searchNsBody = nsName ? findAmbientNamespaceBody(decls, nsName) : decls;
    if (!searchNsBody) continue;

    for (const nsStatement of searchNsBody) {
      const declaration = unwrapExportedDeclaration(nsStatement) ?? nsStatement;
      if (declaration.kind !== NodeKind.InterfaceStatement) continue;
      const iface = declaration as InterfaceStatement;
      if (iface.name?.name !== ifaceName) continue;
      for (const member of iface.members ?? []) {
        if (member.name?.name === symbolName) {
          yield { member, searchNsBody };
        }
      }
    }
  }
}

/**
 * Yields each top-level direct export named `symbolName` from an ambient module's
 * declarations — an `export function` (as a `FunctionStatement`) or an
 * `export const`/`export let` (as a `VarStatement`), unwrapping `ExportStatement`
 * wrappers. Shared by the type, display, and has-export resolvers so they match
 * direct exports identically and differ only in how they project each match.
 */
function* ambientDirectExportMatches(
  decls: readonly Statement[],
  symbolName: string
): Generator<{ kind: "function"; fn: FunctionStatement } | { kind: "var"; variable: VarStatement }> {
  for (const statement of decls) {
    const declaration = unwrapExportedDeclaration(statement) ?? statement;
    if (declaration.kind === NodeKind.FunctionStatement && (declaration as FunctionStatement).name?.name === symbolName) {
      yield { kind: "function", fn: declaration as FunctionStatement };
      continue;
    }
    if (declaration.kind === NodeKind.VarStatement) {
      const variable = declaration as VarStatement;
      const varName = variable.name?.kind === NodeKind.Identifier ? (variable.name as Identifier).name : null;
      if (varName === symbolName) {
        yield { kind: "var", variable };
      }
    }
  }
}

/**
 * Resolves the AnalysisType for a named import (`symbolName`) from an ambient
 * module (`importName`). Handles:
 * - Direct `export function` / `export const` declarations
 * - The `export = X` + `namespace X { interface I { member } }` + `const X: ns.I`
 *   pattern used by @types/node (e.g. `path`, `node:path`)
 * - Strips the `node:` prefix and retries with the base name when needed
 */
export function resolveAmbientNamedImportType(
  importName: string,
  symbolName: string,
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[] = []
): AnalysisType | null {
  const resolutionCache = getAmbientModuleResolutionCache(ambientModuleDeclarations);
  const cacheKey = `${importName}\0${symbolName}`;
  const cached = resolutionCache.namedImportTypes.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const overloads: AnalysisType[] = [];
  const seenOverloads = new Set<string>();
  const pushOverload = (type: AnalysisType): void => {
    const key = typeToString(type);
    if (seenOverloads.has(key)) {
      return;
    }
    seenOverloads.add(key);
    overloads.push(type);
  };

  const candidates = nodeBuiltinSpecifierCandidates(importName);

  for (const candidate of candidates) {
    const decls = ambientModuleDeclarations.get(candidate);
    if (!decls || decls.length === 0) continue;

    // 1. Try direct export with ambient-aware type expansion
    for (const match of ambientDirectExportMatches(decls, symbolName)) {
      if (match.kind === "function") {
        pushOverload(buildAmbientFunctionTypeFromStatement(
          match.fn,
          decls,
          ambientModuleDeclarations,
          ambientGlobalDeclarations
        ));
        continue;
      }
      const resolved = typeFromAmbientAnnotationText(
        match.variable.typeAnnotation?.name,
        decls,
        ambientModuleDeclarations,
        ambientGlobalDeclarations
      );
      resolutionCache.namedImportTypes.set(cacheKey, resolved);
      return resolved;
    }

    const direct = extractDirectTypeForName(decls, symbolName);
    if (direct && direct.kind !== AnalysisTypeKind.Function) {
      resolutionCache.namedImportTypes.set(cacheKey, direct);
      return direct;
    }

    // 2. Follow export = X pattern
    const exportEqualsName = detectAmbientExportEqualsName(decls);
    if (!exportEqualsName) continue;

    // 2a. Look directly inside namespace with the same name
    const nsBody = findAmbientNamespaceBody(decls, exportEqualsName);
    if (nsBody) {
      const fromNs = extractDirectTypeForName(nsBody, symbolName);
      if (fromNs) {
        resolutionCache.namedImportTypes.set(cacheKey, fromNs);
        return fromNs;
      }
    }

    // 2b. Resolve the var statement for the export= name through its interface
    //     members (e.g. `const path: path.PlatformPath`).
    for (const { member, searchNsBody } of ambientExportEqualsInterfaceMembers(decls, exportEqualsName, symbolName)) {
      pushOverload(typeFromAmbientInterfaceMember(
        member,
        searchNsBody,
        ambientModuleDeclarations,
        ambientGlobalDeclarations,
        new Set()
      ));
    }
  }

  if (overloads.length === 1) {
    const resolved = overloads[0] ?? null;
    resolutionCache.namedImportTypes.set(cacheKey, resolved);
    return resolved;
  }
  if (overloads.length > 1) {
    const resolved = unionType(overloads);
    resolutionCache.namedImportTypes.set(cacheKey, resolved);
    return resolved;
  }
  resolutionCache.namedImportTypes.set(cacheKey, null);
  return null;
}

function resolveAmbientNamedImportDisplayType(
  importName: string,
  symbolName: string,
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>
): string | null {
  const resolutionCache = getAmbientModuleResolutionCache(ambientModuleDeclarations);
  const cacheKey = `${importName}\0${symbolName}`;
  const cached = resolutionCache.namedImportDisplayTypes.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const overloads: string[] = [];
  const seenOverloads = new Set<string>();
  const pushOverload = (display: string): void => {
    if (seenOverloads.has(display)) {
      return;
    }
    seenOverloads.add(display);
    overloads.push(display);
  };

  const candidates = nodeBuiltinSpecifierCandidates(importName);

  for (const candidate of candidates) {
    const decls = ambientModuleDeclarations.get(candidate);
    if (!decls || decls.length === 0) continue;

    for (const match of ambientDirectExportMatches(decls, symbolName)) {
      if (match.kind === "function") {
        pushOverload(renderAmbientFunctionDisplayFromStatement(match.fn));
        continue;
      }
      const resolved = renderAmbientTypeAnnotationText(match.variable.typeAnnotation?.name);
      resolutionCache.namedImportDisplayTypes.set(cacheKey, resolved);
      return resolved;
    }

    const exportEqualsName = detectAmbientExportEqualsName(decls);
    if (!exportEqualsName) continue;

    const nsBody = findAmbientNamespaceBody(decls, exportEqualsName);
    if (nsBody) {
      for (const statement of nsBody) {
        const declaration = unwrapExportedDeclaration(statement) ?? statement;
        if (declaration.kind === NodeKind.FunctionStatement && (declaration as FunctionStatement).name?.name === symbolName) {
          return renderAmbientFunctionDisplayFromStatement(declaration as FunctionStatement);
        }
      }
    }

    for (const { member } of ambientExportEqualsInterfaceMembers(decls, exportEqualsName, symbolName)) {
      pushOverload(renderAmbientInterfaceMemberDisplay(member));
    }
  }

  if (overloads.length === 1) {
    const resolved = overloads[0] ?? null;
    resolutionCache.namedImportDisplayTypes.set(cacheKey, resolved);
    return resolved;
  }
  if (overloads.length > 1) {
    const resolved = overloads.join(" | ");
    resolutionCache.namedImportDisplayTypes.set(cacheKey, resolved);
    return resolved;
  }
  resolutionCache.namedImportDisplayTypes.set(cacheKey, null);
  return null;
}

export function ambientModuleHasNamedExport(
  importName: string,
  symbolName: string,
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>
): boolean {
  const candidates = nodeBuiltinSpecifierCandidates(importName, { bidirectional: true });

  for (const candidate of candidates) {
    const decls = ambientModuleDeclarations.get(candidate);
    if (!decls || decls.length === 0) {
      continue;
    }

    for (const _ of ambientDirectExportMatches(decls, symbolName)) {
      return true;
    }

    if (extractDirectTypeForName(decls, symbolName)) {
      return true;
    }

    const exportEqualsName = detectAmbientExportEqualsName(decls);
    if (!exportEqualsName) {
      continue;
    }

    const nsBody = findAmbientNamespaceBody(decls, exportEqualsName);
    if (nsBody && extractDirectTypeForName(nsBody, symbolName)) {
      return true;
    }

    for (const _ of ambientExportEqualsInterfaceMembers(decls, exportEqualsName, symbolName)) {
      return true;
    }
  }

  return false;
}

export interface CollectImportedDeclarationsContext extends ProjectContext {
  uri?: string;
  ambientModuleDeclarations?: ReadonlyMap<string, Statement[]>;
  ambientGlobalDeclarations?: readonly Statement[];
}

async function resolveImportTargetInContext(
  importerFilePath: string,
  importPath: string,
  context: ProjectContext
): Promise<string | null> {
  return resolveImportTargetFilePath(importerFilePath, importPath, {
    vfs: context.vfs,
    importMappings: context.importMappings,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });
}

function unwrapDeclaration(statement: Statement): ImportableDeclaration | null {
  if (statement.kind === NodeKind.VarStatement) {
    const varStatement = statement as VarStatement;
    if (varStatement.receiverType) {
      return varStatement;
    }
  }
  if (statement.kind === NodeKind.FunctionStatement) {
    const functionStatement = statement as FunctionStatement;
    if (functionStatement.receiverType) {
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
  if (candidate.kind === NodeKind.VarStatement) {
    const varStatement = candidate as VarStatement;
    if (varStatement.receiverType) {
      return varStatement;
    }
  }
  // Extension members can be imported from .vx modules without an explicit
  // export so their runtime side effects and type information are available
  // cross-file.
  if (candidate.kind === NodeKind.FunctionStatement) {
    const functionStatement = candidate as FunctionStatement;
    if (functionStatement.receiverType) {
      return functionStatement;
    }
  }
  return null;
}

export interface CollectedImportedDeclarations {
  externalDeclarations: Statement[];
  importedSymbols: Map<string, ImportedSymbolResolution>;
  invalidImportedBindings: Set<string>;
}

function importableDeclarationName(statement: Statement): string | null {
  const namedDeclarationName = (candidate: Statement): string | null => {
    switch (candidate.kind) {
      case NodeKind.ClassStatement:
      case NodeKind.InterfaceStatement:
      case NodeKind.EnumStatement:
      case NodeKind.TypeAliasStatement:
      case NodeKind.FunctionStatement:
        return (candidate as
          | ClassStatement
          | InterfaceStatement
          | EnumStatement
          | TypeAliasStatement
          | FunctionStatement).name.name;
      case NodeKind.NamespaceStatement:
        return (candidate as NamespaceStatement).names?.[0]?.name ?? null;
      default:
        return null;
    }
  };
  const declaration = unwrapDeclaration(statement);
  if (!declaration) {
    const rawDeclaration = unwrapExportedDeclaration(statement) ?? statement;
    const name = namedDeclarationName(rawDeclaration);
    if (name) {
      return name;
    }
    if (rawDeclaration.kind === NodeKind.VarStatement && (rawDeclaration as VarStatement).name.kind === NodeKind.Identifier) {
      return ((rawDeclaration as VarStatement).name as Identifier).name;
    }
    return null;
  }
  const name = namedDeclarationName(declaration);
  if (name) {
    return name;
  }
  if (declaration.kind === NodeKind.VarStatement && declaration.name.kind === NodeKind.Identifier) {
    return declaration.name.name;
  }
  return null;
}

function setImportedSymbolType(
  importedSymbols: Map<string, ImportedSymbolResolution>,
  localName: string,
  type: AnalysisType
): void {
  const resolution = getImportedSymbolResolution(importedSymbols, localName);
  resolution.type = type;
  delete resolution.invalid;
}

function setImportedSymbolDisplayType(
  importedSymbols: Map<string, ImportedSymbolResolution>,
  localName: string,
  displayType: string
): void {
  getImportedSymbolResolution(importedSymbols, localName).displayType = displayType;
}

function setImportedSymbolDeclarationOrigin(
  importedSymbols: Map<string, ImportedSymbolResolution>,
  localName: string,
  statement: Statement,
  filePath: string,
  exportedName: string
): void {
  const resolution = getImportedSymbolResolution(importedSymbols, localName);
  if (resolution.declarationOrigin) {
    return;
  }
  resolution.declarationOrigin = { statement, filePath, exportedName };
}

function markInvalidImportedBinding(
  importedSymbols: Map<string, ImportedSymbolResolution>,
  localName: string
): void {
  const resolution = getImportedSymbolResolution(importedSymbols, localName);
  if (resolution.type || resolution.displayType || resolution.declarationOrigin) {
    return;
  }
  resolution.invalid = true;
}

function shouldIncludeNodeModuleExternalDeclaration(
  statement: Statement,
  wantedNames: ReadonlySet<string>
): boolean {
  const rawDeclaration = unwrapExportedDeclaration(statement) ?? statement;
  if (rawDeclaration.kind === NodeKind.ImportStatement) {
    return true;
  }
  if (rawDeclaration.kind === NodeKind.NamespaceStatement) {
    return true;
  }
  const declaration = unwrapDeclaration(statement);
  if (!declaration) {
    return false;
  }
  if (TYPE_DECLARATION_KINDS.has(declaration.kind)) {
    return true;
  }
  const declarationName = importableDeclarationName(statement);
  return declarationName ? wantedNames.has(declarationName) : false;
}

function collectTypeQueryDependencyNamesFromText(typeText: string | undefined, collected: Set<string>): void {
  if (!typeText) {
    return;
  }
  const stripped = typeText.replace(/"[^"]*"|'[^']*'/g, " ");
  for (const match of stripped.matchAll(/typeof\s+import\s*\(\s*[^)]*\s*\)\s*\.\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)) {
    const fullName = match[1];
    if (!fullName) {
      continue;
    }
    collected.add(fullName);
    const leafName = fullName.split(".").pop();
    if (leafName) {
      collected.add(leafName);
    }
  }
  for (const match of stripped.matchAll(/import\s*\(\s*[^)]*\s*\)\s*\.\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)) {
    const fullName = match[1];
    if (!fullName) {
      continue;
    }
    collected.add(fullName);
    const leafName = fullName.split(".").pop();
    if (leafName) {
      collected.add(leafName);
    }
  }
  for (const match of stripped.matchAll(/typeof\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)) {
    const fullName = match[1];
    if (!fullName) {
      continue;
    }
    collected.add(fullName);
    const leafName = fullName.split(".").pop();
    if (leafName) {
      collected.add(leafName);
    }
  }
  for (const match of stripped.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\b/g)) {
    const fullName = match[1];
    if (!fullName) {
      continue;
    }
    if (
      BUILTIN_TYPE_NAMES.has(fullName)
      || [
        "typeof",
        "import",
        "keyof",
        "infer",
        "extends",
        "readonly",
        "in",
        "as",
        "true",
        "false"
      ].includes(fullName)
    ) {
      continue;
    }
    collected.add(fullName);
    const leafName = fullName.split(".").pop();
    if (leafName && !BUILTIN_TYPE_NAMES.has(leafName)) {
      collected.add(leafName);
    }
  }
}

function collectTypeQueryDependencyNames(statement: Statement, collected: Set<string>): void {
  const rawDeclaration = unwrapExportedDeclaration(statement) ?? statement;
  const queue: unknown[] = [rawDeclaration];
  const visited = new WeakSet<object>();
  const typeBearingKeys = new Set([
    "typeAnnotation",
    "returnType",
    "extendsType",
    "extendsTypes",
    "implementsTypes",
    "receiverType",
    "typeArguments",
    "constraint",
    "defaultType",
    "typeParameters",
    "members",
    "parameters",
    "declarations"
  ]);

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || typeof next !== "object") {
      continue;
    }
    if (visited.has(next)) {
      continue;
    }
    visited.add(next);
    if (Array.isArray(next)) {
      queue.push(...next);
      continue;
    }

    const typeName = (next as { kind?: unknown; name?: unknown }).name;
    if ((next as { kind?: unknown }).kind === NodeKind.Identifier && typeof typeName === "string") {
      collectTypeQueryDependencyNamesFromText(typeName, collected);
    }

    for (const [key, value] of Object.entries(next)) {
      if (!typeBearingKeys.has(key)) {
        continue;
      }
      if (Array.isArray(value)) {
        queue.push(...value);
        continue;
      }
      if (value && typeof value === "object") {
        const typeName = (value as { name?: unknown }).name;
        if (typeof typeName === "string") {
          collectTypeQueryDependencyNamesFromText(typeName, collected);
        }
        queue.push(value);
      }
    }
  }
}

function ambientModuleDeclarationCandidates(
  importPath: string,
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]> | undefined
): Statement[] | null {
  if (!ambientModuleDeclarations) {
    return null;
  }
  return ambientModuleDeclarations.get(importPath)
    ?? (importPath.startsWith("node:") ? ambientModuleDeclarations.get(importPath.slice("node:".length)) ?? null : null);
}

/**
 * Collects imported type declarations and imported symbol details in a single
 * pass over the document's import statements.
 */
export async function collectAllImportedDeclarations(
  ast: Program,
  context: CollectImportedDeclarationsContext
): Promise<CollectedImportedDeclarations> {
  const currentFilePath = context.uri ? uriToFilePath(context.uri) : null;
  const importedSymbols = new Map<string, ImportedSymbolResolution>();
  if (!currentFilePath) {
    return {
      externalDeclarations: [],
      importedSymbols,
      invalidImportedBindings: collectInvalidImportedBindings(importedSymbols)
    };
  }

  const externalDeclarations: Statement[] = [];
  const seen = new Set<ImportableDeclaration>();

  for (const statement of ast.body) {
    if (statement.kind !== NodeKind.ImportStatement) {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const wantedNames = new Set(
      importStatement.specifiers.map((specifier) => specifier.imported.name)
    );
    const targetFilePath = await resolveImportTargetInContext(currentFilePath, importStatement.from.value, context);

    if (!targetFilePath) {
      const nodeModuleTypings = importStatement.defaultImport || importStatement.namespaceImport
        ? await getNodeModuleTypings(
          currentFilePath,
          importStatement.from.value,
          { vfs: context.vfs }
        )
        : await getNodeModuleTypingsForImportNames(
          currentFilePath,
          importStatement.from.value,
          wantedNames,
          { vfs: context.vfs }
        );
      if (nodeModuleTypings) {
        const nodeModuleIndex = getNodeModuleDeclarationIndex(nodeModuleTypings.declarations);
        const declarationOriginByExportedName = new Map<string, ImportedSymbolDeclarationOrigin>();
        for (const entry of nodeModuleTypings.declarationEntries) {
          for (const exportedName of nodeModuleExportedNamesForStatement(entry.statement)) {
            if (declarationOriginByExportedName.has(exportedName)) {
              continue;
            }
            declarationOriginByExportedName.set(exportedName, {
              statement: entry.statement,
              filePath: entry.typingsPath,
              exportedName
            });
          }
        }
        if (nodeModuleTypings.defaultExportName && (importStatement.defaultImport || importStatement.namespaceImport)) {
          wantedNames.add(nodeModuleTypings.defaultExportName);
        }
        const importedNodeModuleDeclarations: Statement[] = [];
        const supportingDeclarationNames = new Set<string>();
        const pendingSupportingDeclarationNames: string[] = [];
        const seenNodeModuleStatements = new Set<Statement>();
        const queuedSupportingDeclarationNames = new Set<string>();
        const queueSupportingDependencyNames = (targetStatement: Statement): void => {
          for (const dependencyName of nodeModuleIndex.dependencyNamesByStatement.get(targetStatement) ?? []) {
            if (supportingDeclarationNames.has(dependencyName)) {
              continue;
            }
            supportingDeclarationNames.add(dependencyName);
            if (queuedSupportingDeclarationNames.has(dependencyName)) {
              continue;
            }
            queuedSupportingDeclarationNames.add(dependencyName);
            pendingSupportingDeclarationNames.push(dependencyName);
          }
        };
        const includeNodeModuleDeclaration = (targetStatement: Statement): void => {
          if (seenNodeModuleStatements.has(targetStatement)) {
            return;
          }
          const declaration = unwrapDeclaration(targetStatement);
          if (!declaration) {
            seenNodeModuleStatements.add(targetStatement);
            const rawDeclaration = unwrapExportedDeclaration(targetStatement) ?? targetStatement;
            importedNodeModuleDeclarations.push(rawDeclaration);
            queueSupportingDependencyNames(targetStatement);
            return;
          }
          if (seen.has(declaration)) {
            return;
          }
          seen.add(declaration);
          seenNodeModuleStatements.add(targetStatement);
          importedNodeModuleDeclarations.push(declaration);
          queueSupportingDependencyNames(targetStatement);
        };
        // For node_modules .d.ts files, include all top-level declarations so
        // imported symbols can still resolve helper types and members without
        // paying to analyze every unrelated export in large packages.
        for (const targetStatement of nodeModuleTypings.declarations) {
          if (!shouldIncludeNodeModuleExternalDeclaration(targetStatement, wantedNames)) {
            continue;
          }
          includeNodeModuleDeclaration(targetStatement);
        }
        while (pendingSupportingDeclarationNames.length > 0) {
          const declarationName = pendingSupportingDeclarationNames.pop();
          if (!declarationName) {
            continue;
          }
          for (const targetStatement of nodeModuleIndex.declarationsByName.get(declarationName) ?? []) {
            if (seenNodeModuleStatements.has(targetStatement)) {
              continue;
            }
            includeNodeModuleDeclaration(targetStatement);
          }
        }
        externalDeclarations.push(...importedNodeModuleDeclarations);
        if (nodeModuleTypings.defaultExportName) {
          const needsDefaultLikeImportType = importStatement.defaultImport || importStatement.namespaceImport;
          const exportType = needsDefaultLikeImportType
            ? namedType(nodeModuleTypings.defaultExportName)
            : null;
          const defaultImportType = needsDefaultLikeImportType
            ? resolveNodeModuleDefaultImportType(
              nodeModuleTypings.declarations,
              nodeModuleTypings.defaultExportName
            )
            : null;
          const namespaceImportType = importStatement.namespaceImport
            ? (() => {
              const namespaceExportProperties = collectNodeModuleNamespaceExportedProperties(nodeModuleTypings.declarations);
              return Object.keys(namespaceExportProperties).length > 0
                ? objectTypeWithProperties(namespaceExportProperties)
                : null;
            })()
            : null;
          if (importStatement.defaultImport) {
            if (defaultImportType) {
              setImportedSymbolType(importedSymbols, importStatement.defaultImport.name, defaultImportType);
              const displayType = displayTypeForExternalFunction(nodeModuleTypings.declarations, nodeModuleTypings.defaultExportName);
              if (displayType) {
                setImportedSymbolDisplayType(importedSymbols, importStatement.defaultImport.name, displayType);
              }
              const declarationOrigin = declarationOriginByExportedName.get(nodeModuleTypings.defaultExportName);
              if (declarationOrigin) {
                setImportedSymbolDeclarationOrigin(
                  importedSymbols,
                  importStatement.defaultImport.name,
                  declarationOrigin.statement,
                  declarationOrigin.filePath,
                  declarationOrigin.exportedName
                );
              }
            }
          }
          if (importStatement.namespaceImport) {
            setImportedSymbolType(
              importedSymbols,
              importStatement.namespaceImport.name,
              namespaceImportType ?? exportType ?? namedType(nodeModuleTypings.defaultExportName)
            );
            const declarationOrigin = declarationOriginByExportedName.get(nodeModuleTypings.defaultExportName);
            if (declarationOrigin) {
              setImportedSymbolDeclarationOrigin(
                importedSymbols,
                importStatement.namespaceImport.name,
                declarationOrigin.statement,
                declarationOrigin.filePath,
                declarationOrigin.exportedName
              );
            }
          }
          for (const specifier of importStatement.specifiers) {
            const localName = (specifier.local ?? specifier.imported).name;
            const importedType = resolveNodeModuleNamedImportType(nodeModuleTypings.declarations, specifier.imported.name);
            if (importedType) {
              setImportedSymbolType(importedSymbols, localName, importedType);
              const displayType = displayTypeForExternalFunction(nodeModuleTypings.declarations, specifier.imported.name);
              if (displayType) {
                setImportedSymbolDisplayType(importedSymbols, localName, displayType);
              }
              const declarationOrigin = declarationOriginByExportedName.get(specifier.imported.name);
              if (declarationOrigin) {
                setImportedSymbolDeclarationOrigin(
                  importedSymbols,
                  localName,
                  declarationOrigin.statement,
                  declarationOrigin.filePath,
                  declarationOrigin.exportedName
                );
              }
            }
          }
        } else if (importStatement.defaultImport) {
          markInvalidImportedBinding(importedSymbols, importStatement.defaultImport.name);
        }
        for (const specifier of importStatement.specifiers) {
          const localName = (specifier.local ?? specifier.imported).name;
          if (importedSymbols.get(localName)?.type) {
            continue;
          }
          const importedType = resolveNodeModuleNamedImportType(nodeModuleTypings.declarations, specifier.imported.name);
          if (importedType) {
            setImportedSymbolType(importedSymbols, localName, importedType);
            const displayType = displayTypeForExternalFunction(nodeModuleTypings.declarations, specifier.imported.name);
            if (displayType) {
              setImportedSymbolDisplayType(importedSymbols, localName, displayType);
            }
            const declarationOrigin = declarationOriginByExportedName.get(specifier.imported.name);
            if (declarationOrigin) {
              setImportedSymbolDeclarationOrigin(
                importedSymbols,
                localName,
                declarationOrigin.statement,
                declarationOrigin.filePath,
                declarationOrigin.exportedName
              );
            }
          } else {
            markInvalidImportedBinding(importedSymbols, localName);
          }
        }
      } else {
        // Fall back to ambient module declarations (e.g. `declare module "fs"` loaded
        // from @types/node via tsconfig compilerOptions.types).
        const importPath = importStatement.from.value;
        const ambientDecls = ambientModuleDeclarationCandidates(importPath, context.ambientModuleDeclarations);
        if (ambientDecls) {
          for (const targetStatement of ambientDecls) {
            if (!seen.has(targetStatement as ImportableDeclaration)) {
              seen.add(targetStatement as ImportableDeclaration);
              externalDeclarations.push(targetStatement);
            }
          }
        }
        if (context.ambientModuleDeclarations) {
          const defaultImportType = importStatement.defaultImport
            ? resolveAmbientDefaultImportType(
              importPath,
              context.ambientModuleDeclarations,
              context.ambientGlobalDeclarations ?? []
            )
            : null;
          if (importStatement.defaultImport) {
            if (defaultImportType) {
              setImportedSymbolType(importedSymbols, importStatement.defaultImport.name, defaultImportType);
              setImportedSymbolDisplayType(
                importedSymbols,
                importStatement.defaultImport.name,
                ambientDefaultImportDisplayType(importPath)
              );
            } else {
              markInvalidImportedBinding(importedSymbols, importStatement.defaultImport.name);
            }
          }
          if (importStatement.namespaceImport) {
            if (defaultImportType) {
              setImportedSymbolType(importedSymbols, importStatement.namespaceImport.name, defaultImportType);
              setImportedSymbolDisplayType(
                importedSymbols,
                importStatement.namespaceImport.name,
                ambientDefaultImportDisplayType(importPath)
              );
            } else {
              markInvalidImportedBinding(importedSymbols, importStatement.namespaceImport.name);
            }
          }
          for (const specifier of importStatement.specifiers) {
            const localName = (specifier.local ?? specifier.imported).name;
            const importedName = specifier.imported.name;
            const type = resolveAmbientNamedImportType(
              importPath,
              importedName,
              context.ambientModuleDeclarations,
              context.ambientGlobalDeclarations ?? []
            );
            if (type) {
              setImportedSymbolType(importedSymbols, localName, type);
            } else {
              markInvalidImportedBinding(importedSymbols, localName);
            }
            const displayType = resolveAmbientNamedImportDisplayType(importPath, importedName, context.ambientModuleDeclarations);
            if (displayType) {
              setImportedSymbolDisplayType(importedSymbols, localName, displayType);
            }
          }
        } else {
          for (const specifier of importStatement.specifiers) {
            markInvalidImportedBinding(importedSymbols, (specifier.local ?? specifier.imported).name);
          }
          if (importStatement.defaultImport) {
            markInvalidImportedBinding(importedSymbols, importStatement.defaultImport.name);
          }
          if (importStatement.namespaceImport) {
            markInvalidImportedBinding(importedSymbols, importStatement.namespaceImport.name);
          }
        }
      }
      continue;
    }

    const targetSession = await getProjectSessionForFilePath(targetFilePath, context);
    const exportedNames = new Set<string>();
    const declarationByExportedName = new Map<string, Statement>();

    if (targetSession?.ast && wantedNames.size > 0) {
      for (const targetStatement of targetSession.ast.body) {
        const declaration = unwrapDeclaration(targetStatement);
        if (!declaration || seen.has(declaration)) {
          continue;
        }
        for (const name of importableTopLevelDeclarationNames(targetStatement, targetFilePath)) {
          exportedNames.add(name);
          if (!declarationByExportedName.has(name)) {
            declarationByExportedName.set(name, declaration);
          }
        }
        const isHelperTypeDeclaration = TYPE_DECLARATION_KINDS.has(declaration.kind);
        if (!isHelperTypeDeclaration && !importableTopLevelDeclarationNames(targetStatement, targetFilePath).some((name) => wantedNames.has(name))) {
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
          setImportedSymbolType(importedSymbols, localName, importedType);
          const declaration = declarationByExportedName.get(specifier.imported.name);
          if (declaration) {
            setImportedSymbolDeclarationOrigin(
              importedSymbols,
              localName,
              declaration,
              targetFilePath,
              specifier.imported.name
            );
          }
        } else if (!exportedNames.has(specifier.imported.name)) {
          markInvalidImportedBinding(importedSymbols, localName);
        }
      }
    }
    if (targetSession?.ast && wantedNames.size > 0) {
      for (const specifier of importStatement.specifiers) {
        const localName = (specifier.local ?? specifier.imported).name;
        const declaration = declarationByExportedName.get(specifier.imported.name);
        if (declaration) {
          setImportedSymbolDeclarationOrigin(
            importedSymbols,
            localName,
            declaration,
            targetFilePath,
            specifier.imported.name
          );
        }
        if (importedSymbols.get(localName)?.type) {
          continue;
        }
        if (!exportedNames.has(specifier.imported.name)) {
          markInvalidImportedBinding(importedSymbols, localName);
        }
      }
    }
  }

  return {
    externalDeclarations,
    importedSymbols,
    invalidImportedBindings: collectInvalidImportedBindings(importedSymbols)
  };
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
  return (await collectAllImportedDeclarations(ast, context)).externalDeclarations;
}
