import type {
  ClassStatement,
  EnumStatement,
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
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import { importableTopLevelDeclarationNames } from "./declarationResolver";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { detectAmbientExportEqualsName, findAmbientNamespaceBody } from "./crossFileContext";
import {
  renderAmbientFunctionDisplayFromStatement,
  renderAmbientInterfaceMemberDisplay,
  renderAmbientTypeAnnotationText
} from "./ambientDisplay";
import type { AnalysisType, ArrayType } from "compiler/analysis/types";
import {
  BUILTIN_TYPE_NAMES,
  arrayType,
  builtinType,
  functionType,
  intersectionType,
  literalType,
  namedType,
  objectTypeWithProperties,
  unionType,
  typeToString,
  UNKNOWN_TYPE
} from "compiler/analysis/types";
import {
  findMatchingTypeDelimiter,
  findTopLevelTypeCharacter,
  parseTypeNameShape,
  splitTopLevelDelimitedTypeText,
  splitTopLevelTypeText,
  stripEnclosingTypeParens
} from "compiler/analysis/typeNames";
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
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    const members = splitTopLevelDelimitedTypeText(normalized.slice(1, -1), new Set([","]));
    return {
      kind: "tuple",
      elements: members.map((member) => typeFromAnnotationText(member.trim())).filter((member) => member !== UNKNOWN_TYPE)
    };
  }
  const unionParts = splitTopLevelTypeText(normalized, "|");
  if (unionParts.length > 1) {
    return unionType(unionParts.map((part) => typeFromAnnotationText(part)));
  }
  const intersectionParts = splitTopLevelTypeText(normalized, "&");
  if (intersectionParts.length > 1) {
    return intersectionType(intersectionParts.map((part) => typeFromAnnotationText(part)));
  }
  const arrowIndex = normalized.indexOf("=>");
  const parameterListEnd = normalized.startsWith("(")
    ? findMatchingTypeDelimiter(normalized, 0, "(", ")")
    : -1;
  if (parameterListEnd > 0 && arrowIndex > parameterListEnd) {
    const parameterText = normalized.slice(1, parameterListEnd).trim();
    const returnText = normalized.slice(arrowIndex + 2).trim();
    return functionType(
      parameterText.length === 0
        ? []
        : splitTopLevelDelimitedTypeText(parameterText, new Set([","])).map((parameter, index) => ({
            name: `arg${index}`,
            type: typeFromAnnotationText(parameter.split(":").slice(1).join(":").trim() || parameter.trim())
          })),
      typeFromAnnotationText(returnText)
    );
  }
  const parsed = parseTypeNameShape(normalized);
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
  const overloads: AnalysisType[] = [];
  for (const statement of declarations) {
    if (statement.kind !== "ExportStatement") {
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
    overloads.push(functionType(
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
    ));
  }
  if (overloads.length === 0) {
    return null;
  }
  return overloads.length === 1 ? overloads[0]! : unionType(overloads);
}

function resolveNodeModuleNamedImportType(
  declarations: readonly Statement[],
  importedName: string
): AnalysisType | null {
  const callableType = callableTypeFromExternalFunction(declarations, importedName);
  if (callableType) {
    return callableType;
  }

  for (const statement of declarations) {
    const declaration = unwrapExportedDeclaration(statement);
    if (!declaration) {
      continue;
    }
    if (declaration.kind === "ClassStatement" && (declaration as ClassStatement).name.name === importedName) {
      return namedType(importedName);
    }
    if (declaration.kind === "InterfaceStatement" && (declaration as InterfaceStatement).name.name === importedName) {
      return namedType(importedName);
    }
    if (declaration.kind === "EnumStatement" && (declaration as EnumStatement).name.name === importedName) {
      return namedType(importedName);
    }
    if (declaration.kind === "TypeAliasStatement" && (declaration as TypeAliasStatement).name.name === importedName) {
      return namedType(importedName);
    }
    if (declaration.kind === "VarStatement") {
      const varStatement = declaration as VarStatement;
      if (varStatement.name.kind === "Identifier" && varStatement.name.name === importedName) {
        return typeFromAnnotationText(varStatement.typeAnnotation?.name);
      }
    }
  }

  return null;
}

export function buildFunctionTypeFromStatement(fn: FunctionStatement): AnalysisType {
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

function findAmbientInterfaceStatement(
  declarations: readonly Statement[],
  typeName: string
): InterfaceStatement | null {
  for (const statement of declarations) {
    const declaration = statement.kind === "ExportStatement"
      ? (statement as { declaration?: Statement }).declaration ?? statement
      : statement;
    if (declaration.kind === "InterfaceStatement" && (declaration as InterfaceStatement).name.name === typeName) {
      return declaration as InterfaceStatement;
    }
  }
  return null;
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
    if (local.kind !== "named" || local.name !== typeName || (local.typeArguments?.length ?? 0) > 0) {
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
      fromNamespace.kind !== "named"
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

  const parsed = parseTypeNameShape(normalized);
  const resolvedTypeArguments = parsed.typeArguments.map((argument) =>
    typeFromAmbientAnnotationText(argument, declarations, ambientModuleDeclarations, ambientGlobalDeclarations, visited)
  );
  let resolvedBase: AnalysisType;

  if (BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
    resolvedBase = builtinType(parsed.baseName as Parameters<typeof builtinType>[0]);
  } else {
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
            const importedReference = findAmbientImportedTypeReference(declarations, parsed.baseName);
            if (importedReference) {
              resolvedBase = resolveAmbientTypeReference(
                importedReference.importPath,
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
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[] = []
): AnalysisType {
  return functionType(
    fn.parameters
      .filter((p) => p.thisParameter !== true)
      .map((p) => {
        const rawType = typeFromAmbientAnnotationText(
          p.typeAnnotation?.name,
          declarations,
          ambientModuleDeclarations,
          ambientGlobalDeclarations
        );
        const isRest = p.rest === true;
        const type = isRest && rawType.kind === "array" ? (rawType as ArrayType).elementType : rawType;
        return {
          name: p.name.kind === "Identifier" ? (p.name as Identifier).name : "arg",
          type,
          optional: p.optional === true || p.defaultValue !== undefined || isRest,
          rest: isRest
        };
      }),
    typeFromAmbientAnnotationText(fn.returnType?.name, declarations, ambientModuleDeclarations, ambientGlobalDeclarations),
    fn.typeParameters?.map((tp) => tp.name.name)
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
    member.parameters
      .filter((p) => p.thisParameter !== true)
      .map((p) => {
        const rawType = typeFromAmbientAnnotationText(
          p.typeAnnotation?.name,
          declarations,
          ambientModuleDeclarations,
          ambientGlobalDeclarations,
          visited
        );
        const isRest = p.rest === true;
        const type = isRest && rawType.kind === "array" ? (rawType as ArrayType).elementType : rawType;
        return {
          name: p.name.kind === "Identifier" ? (p.name as Identifier).name : "arg",
          type,
          optional: p.optional === true || p.defaultValue !== undefined || isRest,
          rest: isRest
        };
      }),
    typeFromAmbientAnnotationText(
      member.returnType?.name,
      declarations,
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
  if (member.kind === "InterfaceMethodMember") {
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

function collectAmbientNamespaceExportedProperties(
  statements: readonly Statement[],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[]
): Record<string, AnalysisType> {
  const properties: Record<string, AnalysisType> = {};
  for (const statement of statements) {
    const declaration =
      statement.kind === "ExportStatement"
        ? (statement as { declaration?: Statement }).declaration ?? statement
        : statement;

    if (declaration.kind === "FunctionStatement") {
      const fn = declaration as FunctionStatement;
      properties[fn.name.name] = buildAmbientFunctionTypeFromStatement(
        fn,
        statements,
        ambientModuleDeclarations,
        ambientGlobalDeclarations
      );
      continue;
    }
    if (declaration.kind === "VarStatement") {
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
    if (declaration.kind === "ClassStatement") {
      properties[(declaration as ClassStatement).name.name] = namedType((declaration as ClassStatement).name.name);
      continue;
    }
    if (declaration.kind === "InterfaceStatement") {
      properties[(declaration as InterfaceStatement).name.name] = namedType((declaration as InterfaceStatement).name.name);
      continue;
    }
    if (declaration.kind === "TypeAliasStatement") {
      properties[(declaration as TypeAliasStatement).name.name] = namedType((declaration as TypeAliasStatement).name.name);
      continue;
    }
    if (declaration.kind === "NamespaceStatement") {
      const namespaceName = (declaration as NamespaceStatement).names?.[0]?.name;
      if (namespaceName) {
        properties[namespaceName] = namedType(namespaceName);
      }
    }
  }
  return properties;
}

function collectNodeModuleNamespaceExportedProperties(
  statements: readonly Statement[]
): Record<string, AnalysisType> {
  const properties: Record<string, AnalysisType> = {};
  for (const statement of statements) {
    const declaration =
      statement.kind === "ExportStatement"
        ? (statement as { declaration?: Statement }).declaration ?? statement
        : statement;

    if (declaration.kind === "FunctionStatement") {
      const fn = declaration as FunctionStatement;
      properties[fn.name.name] = buildFunctionTypeFromStatement(fn);
      continue;
    }
    if (declaration.kind === "VarStatement") {
      const variable = declaration as VarStatement;
      const bindings = variable.declarations?.flatMap((item) => bindingIdentifiers(item.name)) ?? bindingIdentifiers(variable.name);
      for (const binding of bindings) {
        properties[binding.name] = typeFromAnnotationText(variable.typeAnnotation?.name);
      }
      continue;
    }
    if (declaration.kind === "ClassStatement") {
      properties[(declaration as ClassStatement).name.name] = namedType((declaration as ClassStatement).name.name);
      continue;
    }
    if (declaration.kind === "InterfaceStatement") {
      properties[(declaration as InterfaceStatement).name.name] = namedType((declaration as InterfaceStatement).name.name);
      continue;
    }
    if (declaration.kind === "EnumStatement") {
      properties[(declaration as EnumStatement).name.name] = namedType((declaration as EnumStatement).name.name);
      continue;
    }
    if (declaration.kind === "TypeAliasStatement") {
      properties[(declaration as TypeAliasStatement).name.name] = namedType((declaration as TypeAliasStatement).name.name);
      continue;
    }
    if (declaration.kind === "NamespaceStatement") {
      const namespaceName = (declaration as NamespaceStatement).names?.[0]?.name;
      if (namespaceName) {
        properties[namespaceName] = namedType(namespaceName);
      }
    }
  }
  return properties;
}

function resolveAmbientDefaultImportType(
  importName: string,
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>,
  ambientGlobalDeclarations: readonly Statement[] = []
): AnalysisType | null {
  let fallbackNamedExport: AnalysisType | null = null;
  for (const decls of ambientModuleCandidates(importName, ambientModuleDeclarations)) {
    if (decls.length === 0) {
      continue;
    }

    const exportEqualsName = detectAmbientExportEqualsName(decls);

    for (const statement of decls) {
      if (statement.kind !== "ExportStatement" || (statement as { default?: boolean }).default !== true) {
        continue;
      }
      const declaration = (statement as { declaration?: Statement }).declaration;
      if (declaration?.kind === "FunctionStatement") {
        return buildAmbientFunctionTypeFromStatement(
          declaration as FunctionStatement,
          decls,
          ambientModuleDeclarations,
          ambientGlobalDeclarations
        );
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
      return objectTypeWithProperties(directExports);
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
        return callableExport?.kind === "function"
          ? intersectionType([callableExport, objectTypeWithProperties(namespaceExports)])
          : objectTypeWithProperties(namespaceExports);
      }
    }

    for (const statement of decls) {
      if (statement.kind !== "VarStatement") {
        continue;
      }
      const variable = statement as VarStatement;
      const varName = variable.name?.kind === "Identifier" ? (variable.name as Identifier).name : null;
      if (varName !== exportEqualsName) {
        continue;
      }
      const resolvedType = typeFromAmbientAnnotationText(
        variable.typeAnnotation?.name,
        decls,
        ambientModuleDeclarations,
        ambientGlobalDeclarations
      );
      if (resolvedType.kind !== "unknown") {
        return callableExport?.kind === "function"
          ? intersectionType([callableExport, resolvedType])
          : resolvedType;
      }
    }

    if (callableExport) {
      return callableExport;
    }
    fallbackNamedExport ??= namedType(exportEqualsName);
  }
  return fallbackNamedExport;
}

function ambientDefaultImportDisplayType(importName: string): string {
  return `typeof import("${importName}")`;
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
        pushOverload(buildAmbientFunctionTypeFromStatement(
          declaration as FunctionStatement,
          decls,
          ambientModuleDeclarations,
          ambientGlobalDeclarations
        ));
        continue;
      }
      if (declaration.kind === "VarStatement") {
        const variable = declaration as VarStatement;
          const varName = variable.name?.kind === "Identifier" ? (variable.name as Identifier).name : null;
        if (varName === symbolName) {
          return typeFromAmbientAnnotationText(
            variable.typeAnnotation?.name,
            decls,
            ambientModuleDeclarations,
            ambientGlobalDeclarations
          );
        }
      }
    }

    const direct = extractDirectTypeForName(decls, symbolName);
    if (direct && direct.kind !== "function") {
      return direct;
    }

    // 2. Follow export = X pattern
    const exportEqualsName = detectAmbientExportEqualsName(decls);
    if (!exportEqualsName) continue;

    // 2a. Look directly inside namespace with the same name
    const nsBody = findAmbientNamespaceBody(decls, exportEqualsName);
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

      const searchNsBody = nsName ? findAmbientNamespaceBody(decls, nsName) : decls;
      if (!searchNsBody) continue;

      for (const s of searchNsBody) {
        const d =
          s.kind === "ExportStatement"
            ? (s as { declaration?: Statement }).declaration ?? s
            : s;
        if (d.kind !== "InterfaceStatement") continue;
        const iface = d as InterfaceStatement;
        if (iface.name?.name !== ifaceName) continue;
        const members = (iface.members ?? []).filter((m) => m.name?.name === symbolName);
        for (const member of members) {
          pushOverload(typeFromAmbientInterfaceMember(
            member,
            searchNsBody,
            ambientModuleDeclarations,
            ambientGlobalDeclarations,
            new Set()
          ));
        }
      }
    }
  }

  if (overloads.length === 1) {
    return overloads[0] ?? null;
  }
  if (overloads.length > 1) {
    return unionType(overloads);
  }
  return null;
}

function resolveAmbientNamedImportDisplayType(
  importName: string,
  symbolName: string,
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>
): string | null {
  const overloads: string[] = [];
  const seenOverloads = new Set<string>();
  const pushOverload = (display: string): void => {
    if (seenOverloads.has(display)) {
      return;
    }
    seenOverloads.add(display);
    overloads.push(display);
  };

  const candidates = [importName];
  if (importName.startsWith("node:")) {
    candidates.push(importName.slice("node:".length));
  }

  for (const candidate of candidates) {
    const decls = ambientModuleDeclarations.get(candidate);
    if (!decls || decls.length === 0) continue;

    for (const statement of decls) {
      const declaration =
        statement.kind === "ExportStatement"
          ? (statement as { declaration?: Statement }).declaration ?? statement
          : statement;

      if (declaration.kind === "FunctionStatement" && (declaration as FunctionStatement).name?.name === symbolName) {
        pushOverload(renderAmbientFunctionDisplayFromStatement(declaration as FunctionStatement));
        continue;
      }
      if (declaration.kind === "VarStatement") {
        const variable = declaration as VarStatement;
        const varName = variable.name?.kind === "Identifier" ? (variable.name as Identifier).name : null;
        if (varName === symbolName) {
          return renderAmbientTypeAnnotationText(variable.typeAnnotation?.name);
        }
      }
    }

    const exportEqualsName = detectAmbientExportEqualsName(decls);
    if (!exportEqualsName) continue;

    const nsBody = findAmbientNamespaceBody(decls, exportEqualsName);
    if (nsBody) {
      for (const statement of nsBody) {
        const declaration =
          statement.kind === "ExportStatement"
            ? (statement as { declaration?: Statement }).declaration ?? statement
            : statement;
        if (declaration.kind === "FunctionStatement" && (declaration as FunctionStatement).name?.name === symbolName) {
          return renderAmbientFunctionDisplayFromStatement(declaration as FunctionStatement);
        }
      }
    }

    for (const stmt of decls) {
      if (stmt.kind !== "VarStatement") continue;
      const v = stmt as VarStatement;
      const varName = v.name?.kind === "Identifier" ? (v.name as Identifier).name : null;
      const typeName = (v as { typeAnnotation?: { name?: string } }).typeAnnotation?.name;
      if (varName !== exportEqualsName || !typeName) continue;

      const dotIdx = typeName.lastIndexOf(".");
      const nsName = dotIdx > 0 ? typeName.slice(0, dotIdx) : null;
      const ifaceName = dotIdx > 0 ? typeName.slice(dotIdx + 1) : typeName;
      const searchNsBody = nsName ? findAmbientNamespaceBody(decls, nsName) : decls;
      if (!searchNsBody) continue;

      for (const s of searchNsBody) {
        const d =
          s.kind === "ExportStatement"
            ? (s as { declaration?: Statement }).declaration ?? s
            : s;
        if (d.kind !== "InterfaceStatement") continue;
        const iface = d as InterfaceStatement;
        if (iface.name?.name !== ifaceName) continue;
        const members = (iface.members ?? []).filter((m) => m.name?.name === symbolName);
        for (const member of members) {
          pushOverload(renderAmbientInterfaceMemberDisplay(member));
        }
      }
    }
  }

  if (overloads.length === 1) {
    return overloads[0] ?? null;
  }
  if (overloads.length > 1) {
    return overloads.join(" | ");
  }
  return null;
}

export function ambientModuleHasNamedExport(
  importName: string,
  symbolName: string,
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>
): boolean {
  const candidates = [importName];
  if (importName.startsWith("node:")) {
    candidates.push(importName.slice("node:".length));
  } else {
    candidates.push(`node:${importName}`);
  }

  for (const candidate of candidates) {
    const decls = ambientModuleDeclarations.get(candidate);
    if (!decls || decls.length === 0) {
      continue;
    }

    for (const statement of decls) {
      const declaration =
        statement.kind === "ExportStatement"
          ? (statement as { declaration?: Statement }).declaration ?? statement
          : statement;

      if (declaration.kind === "FunctionStatement" && (declaration as FunctionStatement).name?.name === symbolName) {
        return true;
      }
      if (declaration.kind === "VarStatement") {
        const variable = declaration as VarStatement;
        const varName = variable.name?.kind === "Identifier" ? (variable.name as Identifier).name : null;
        if (varName === symbolName) {
          return true;
        }
      }
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

    for (const stmt of decls) {
      if (stmt.kind !== "VarStatement") continue;
      const variable = stmt as VarStatement;
      const varName = variable.name?.kind === "Identifier" ? (variable.name as Identifier).name : null;
      const typeName = variable.typeAnnotation?.name;
      if (varName !== exportEqualsName || !typeName) continue;

      const dotIdx = typeName.lastIndexOf(".");
      const nsName = dotIdx > 0 ? typeName.slice(0, dotIdx) : null;
      const ifaceName = dotIdx > 0 ? typeName.slice(dotIdx + 1) : typeName;
      const searchNsBody = nsName ? findAmbientNamespaceBody(decls, nsName) : decls;
      if (!searchNsBody) continue;

      for (const statement of searchNsBody) {
        const declaration =
          statement.kind === "ExportStatement"
            ? (statement as { declaration?: Statement }).declaration ?? statement
            : statement;
        if (declaration.kind !== "InterfaceStatement") continue;
        const iface = declaration as InterfaceStatement;
        if (iface.name?.name !== ifaceName) continue;
        if ((iface.members ?? []).some((member) => member.name?.name === symbolName)) {
          return true;
        }
      }
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
  if (candidate.kind === "VarStatement") {
    const varStatement = candidate as VarStatement;
    if (varStatement.receiverType) {
      return varStatement;
    }
  }
  // Extension members can be imported from .vx modules without an explicit
  // export so their runtime side effects and type information are available
  // cross-file.
  if (candidate.kind === "FunctionStatement") {
    const functionStatement = candidate as FunctionStatement;
    if (functionStatement.receiverType) {
      return functionStatement;
    }
  }
  return null;
}

export interface CollectedImportedDeclarations {
  externalDeclarations: Statement[];
  importedSymbolTypes: Map<string, AnalysisType>;
  importedSymbolDisplayTypes: Map<string, string>;
  invalidImportedBindings: Set<string>;
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
    return {
      externalDeclarations: [],
      importedSymbolTypes: new Map(),
      importedSymbolDisplayTypes: new Map(),
      invalidImportedBindings: new Set()
    };
  }

  const externalDeclarations: Statement[] = [];
  const importedSymbolTypes = new Map<string, AnalysisType>();
  const importedSymbolDisplayTypes = new Map<string, string>();
  const invalidImportedBindings = new Set<string>();
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
        const namespaceExportProperties = collectNodeModuleNamespaceExportedProperties(nodeModuleTypings.declarations);
        const namespaceImportType = Object.keys(namespaceExportProperties).length > 0
          ? objectTypeWithProperties(namespaceExportProperties)
          : null;
        if (nodeModuleTypings.defaultExportName) {
          const exportType = namedType(nodeModuleTypings.defaultExportName);
          const defaultImportType = callableTypeFromExternalFunction(nodeModuleTypings.declarations, nodeModuleTypings.defaultExportName) ?? exportType;
          if (importStatement.defaultImport) {
            importedSymbolTypes.set(importStatement.defaultImport.name, defaultImportType);
          }
          if (importStatement.namespaceImport) {
            importedSymbolTypes.set(importStatement.namespaceImport.name, namespaceImportType ?? exportType);
          }
          for (const specifier of importStatement.specifiers) {
            const localName = (specifier.local ?? specifier.imported).name;
            const importedType = resolveNodeModuleNamedImportType(nodeModuleTypings.declarations, specifier.imported.name);
            if (importedType) {
              importedSymbolTypes.set(localName, importedType);
            }
          }
        } else if (importStatement.defaultImport) {
          invalidImportedBindings.add(importStatement.defaultImport.name);
        }
        for (const specifier of importStatement.specifiers) {
          const localName = (specifier.local ?? specifier.imported).name;
          if (importedSymbolTypes.has(localName)) {
            continue;
          }
          const importedType = resolveNodeModuleNamedImportType(nodeModuleTypings.declarations, specifier.imported.name);
          if (importedType) {
            importedSymbolTypes.set(localName, importedType);
          } else {
            invalidImportedBindings.add(localName);
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
              importedSymbolTypes.set(importStatement.defaultImport.name, defaultImportType);
              importedSymbolDisplayTypes.set(
                importStatement.defaultImport.name,
                ambientDefaultImportDisplayType(importPath)
              );
            } else {
              invalidImportedBindings.add(importStatement.defaultImport.name);
            }
          }
          if (importStatement.namespaceImport) {
            if (defaultImportType) {
              importedSymbolTypes.set(importStatement.namespaceImport.name, defaultImportType);
              importedSymbolDisplayTypes.set(
                importStatement.namespaceImport.name,
                ambientDefaultImportDisplayType(importPath)
              );
            } else {
              invalidImportedBindings.add(importStatement.namespaceImport.name);
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
                importedSymbolTypes.set(localName, type);
              } else {
                invalidImportedBindings.add(localName);
              }
              const displayType = resolveAmbientNamedImportDisplayType(importPath, importedName, context.ambientModuleDeclarations);
              if (displayType) {
                importedSymbolDisplayTypes.set(localName, displayType);
              }
            }
          }
        } else {
          for (const specifier of importStatement.specifiers) {
            invalidImportedBindings.add((specifier.local ?? specifier.imported).name);
          }
          if (importStatement.defaultImport) {
            invalidImportedBindings.add(importStatement.defaultImport.name);
          }
          if (importStatement.namespaceImport) {
            invalidImportedBindings.add(importStatement.namespaceImport.name);
          }
        }
      }
      continue;
    }

    const wantedNames = new Set(
      importStatement.specifiers.map((specifier) => specifier.imported.name)
    );

    const targetSession = await getProjectSessionForFilePath(targetFilePath, context);
    const exportedNames = new Set<string>();

    if (targetSession?.ast && wantedNames.size > 0) {
      for (const targetStatement of targetSession.ast.body) {
        const declaration = unwrapDeclaration(targetStatement);
        if (!declaration || seen.has(declaration)) {
          continue;
        }
        for (const name of importableTopLevelDeclarationNames(targetStatement, targetFilePath)) {
          exportedNames.add(name);
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
          importedSymbolTypes.set(localName, importedType);
        } else if (!exportedNames.has(specifier.imported.name)) {
          invalidImportedBindings.add(localName);
        }
      }
    }
    if (targetSession?.ast && wantedNames.size > 0) {
      for (const specifier of importStatement.specifiers) {
        const localName = (specifier.local ?? specifier.imported).name;
        if (importedSymbolTypes.has(localName)) {
          continue;
        }
        if (!exportedNames.has(specifier.imported.name)) {
          invalidImportedBindings.add(localName);
        }
      }
    }
  }

  return { externalDeclarations, importedSymbolTypes, importedSymbolDisplayTypes, invalidImportedBindings };
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
      if (!importableTopLevelDeclarationNames(targetStatement, targetFilePath).some((name) => wantedNames.has(name))) {
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
        const namespaceExportProperties = collectNodeModuleNamespaceExportedProperties(nodeModuleTypings.declarations);
        const namespaceImportType = Object.keys(namespaceExportProperties).length > 0
          ? objectTypeWithProperties(namespaceExportProperties)
          : null;
        if (importStatement.defaultImport) {
          result.set(importStatement.defaultImport.name, defaultImportType);
        }
        if (importStatement.namespaceImport) {
          result.set(importStatement.namespaceImport.name, namespaceImportType ?? exportType);
        }
        for (const specifier of importStatement.specifiers) {
          const localName = (specifier.local ?? specifier.imported).name;
          const importedTypeName = specifier.imported.name;
          result.set(
            localName,
            callableTypeFromExternalFunction(nodeModuleTypings.declarations, importedTypeName) ?? namedType(importedTypeName)
          );
        }
      } else {
        const ambientDefaultType = context.ambientModuleDeclarations
          ? resolveAmbientDefaultImportType(
            importStatement.from.value,
            context.ambientModuleDeclarations,
            context.ambientGlobalDeclarations ?? []
          )
          : null;
        if (ambientDefaultType) {
          if (importStatement.defaultImport) {
            result.set(importStatement.defaultImport.name, ambientDefaultType);
          }
          if (importStatement.namespaceImport) {
            result.set(importStatement.namespaceImport.name, ambientDefaultType);
          }
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
