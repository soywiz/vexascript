import { bindingIdentifiers, bindingNameText } from "compiler/ast/bindingPatterns";
import type { Analysis } from "compiler/analysis/Analysis";
import { baseTypeName, parseTypeNameShape, substituteTypeNameText } from "compiler/analysis/typeNames";
import { type AnalysisType, typeToString } from "compiler/analysis/types";
import type {
  AsExpression,
  AssignmentExpression,
  BinaryExpression,
  CallExpression,
  ClassStatement,
  FunctionStatement,
  ImportStatement,
  InterfaceStatement,
  NamespaceStatement,
  ConditionalExpression,
  Expr,
  FunctionParameter,
  Identifier,
  MemberExpression,
  NewExpression,
  NonNullExpression,
  Statement,
  VarDeclarator,
  VarStatement,
  UnaryExpression,
  UpdateExpression,
  Program
} from "compiler/ast/ast";
import { getNodeModuleTypings } from "./nodeModulesTypings";
import { uriToFilePath } from "./importFixes";
import { readDocumentationFromIdentifier, readDocumentationFromProgramDeclaration } from "./documentation";
import {
  findTopLevelDeclarationInProgram,
  isClassStatement,
  isInterfaceStatement,
  resolveTopLevelDeclarationAcrossFiles
} from "./declarationResolver";
import { walkAst } from "compiler/ast/traversal";
import {
  type ProjectContext,
  type ProjectSessionLike
} from "./projectAnalysis";

const BUILTIN_TYPE_NAMES = new Set([
  "int",
  "number",
  "numeric",
  "string",
  "boolean",
  "bigint",
  "long",
  "null",
  "undefined"
]);

export type ClassResolverSessionLike = ProjectSessionLike;

export interface ClassResolverOptions extends ProjectContext {
  uri?: string;
}

export interface ResolvedClassStatement {
  classStatement: ClassStatement;
  filePath: string;
}

export interface ResolvedInterfaceStatement {
  interfaceStatement: InterfaceStatement;
  filePath: string;
}

export interface ResolvedParameter {
  name: string;
  typeName: string;
  optional: boolean;
  rest?: boolean;
}

export interface ResolvedFunctionSignature {
  name: string;
  parameters: ResolvedParameter[];
  returnTypeName: string;
  documentation?: string;
}

export interface ResolvedClassMember {
  className: string;
  memberName: string;
  kind: "field" | "method";
  typeName: string;
  signature?: ResolvedFunctionSignature;
  documentation?: string;
}

export interface ResolvedClassMemberDeclaration {
  classStatement: ClassStatement;
  filePath: string;
  memberName: string;
  kind: "field" | "method";
}

export interface ResolvedTypeMemberDeclaration {
  declaration: ClassStatement | InterfaceStatement;
  filePath: string;
  memberName: string;
  kind: "field" | "method";
}

export interface ResolvedConstructorSignature {
  className: string;
  parameters: ResolvedParameter[];
}

export interface ClassResolverCache {
  classStatementByName: Map<string, ResolvedClassStatement | null>;
  interfaceStatementByName: Map<string, ResolvedInterfaceStatement | null>;
  classMemberByRequest: Map<string, ResolvedClassMember | null>;
  interfaceMemberByRequest: Map<string, ResolvedClassMember | null>;
}

export interface ResolveClassMemberContext {
  ast: Program;
  options: ClassResolverOptions;
  cache?: ClassResolverCache;
}

interface ResolutionContext {
  ast: Program;
  options: ClassResolverOptions;
  cache: ClassResolverCache;
}

export function createClassResolverCache(): ClassResolverCache {
  return {
    classStatementByName: new Map(),
    interfaceStatementByName: new Map(),
    classMemberByRequest: new Map(),
    interfaceMemberByRequest: new Map()
  };
}

function typeParameterSubstitutions(
  typeParameters: Array<{ name: Identifier }> | undefined,
  objectTypeName: string | undefined
): Map<string, string> {
  const substitutions = new Map<string, string>();
  if (!objectTypeName) {
    return substitutions;
  }

  const parsedObjectType = parseTypeNameShape(objectTypeName);
  const declaredTypeParameters = typeParameters ?? [];
  for (let i = 0; i < declaredTypeParameters.length; i += 1) {
    const parameterName = declaredTypeParameters[i]?.name.name;
    if (!parameterName) {
      continue;
    }
    substitutions.set(parameterName, parsedObjectType.typeArguments[i] ?? parameterName);
  }

  return substitutions;
}

function classMemberCacheKey(
  className: string,
  memberName: string,
  objectTypeName: string | undefined
): string {
  return `${className}|${memberName}|${objectTypeName ?? "<none>"}`;
}

function interfaceMemberCacheKey(
  interfaceName: string,
  memberName: string,
  objectTypeName: string | undefined
): string {
  return `${interfaceName}|${memberName}|${objectTypeName ?? "<none>"}`;
}

export function findClassStatementInProgram(ast: Program, className: string): ClassStatement | null {
  return findTopLevelDeclarationInProgram(ast, className, isClassStatement);
}

export async function resolveClassStatementAcrossFiles(
  ast: Program,
  className: string,
  options: ClassResolverOptions,
  cache?: ClassResolverCache
): Promise<ResolvedClassStatement | null> {
  const resolverCache = cache ?? createClassResolverCache();
  const cached = resolverCache.classStatementByName.get(className);
  if (cached !== undefined) {
    return cached;
  }

  const resolved = await resolveTopLevelDeclarationAcrossFiles({
    ast,
    name: className,
    currentFilePath: options.uri ? uriToFilePath(options.uri) : null,
    predicate: isClassStatement,
    includeRuntime: true,
    sourceRoots: options.sourceRoots ?? [],
    ...(options.getSessionForFilePath
      ? { getSessionForFilePath: options.getSessionForFilePath }
      : {})
  });

  const classStatement = resolved
    ? {
        classStatement: resolved.declaration,
        filePath: resolved.filePath
      }
    : null;
  resolverCache.classStatementByName.set(className, classStatement);
  return classStatement;
}

export async function resolveInterfaceStatementAcrossFiles(
  ast: Program,
  interfaceName: string,
  options: ClassResolverOptions,
  cache: ClassResolverCache
): Promise<ResolvedInterfaceStatement | null> {
  const cached = cache.interfaceStatementByName.get(interfaceName);
  if (cached !== undefined) {
    return cached;
  }

  const resolved = await resolveTopLevelDeclarationAcrossFiles({
    ast,
    name: interfaceName,
    currentFilePath: options.uri ? uriToFilePath(options.uri) : null,
    predicate: isInterfaceStatement,
    includeRuntime: true,
    sourceRoots: options.sourceRoots ?? [],
    ...(options.getSessionForFilePath
      ? { getSessionForFilePath: options.getSessionForFilePath }
      : {})
  });

  const interfaceStatement = resolved
    ? {
        interfaceStatement: resolved.declaration,
        filePath: resolved.filePath
      }
    : null;
  cache.interfaceStatementByName.set(interfaceName, interfaceStatement);
  return interfaceStatement;
}

function typeNameFromAnalysisType(type: AnalysisType | undefined): string | null {
  if (!type) {
    return null;
  }
  if (type.kind === "builtin") {
    return type.name;
  }
  if (type.kind === "named") {
    return typeToString(type);
  }
  return typeToString(type);
}

function explicitTypeNameFromNewExpression(newExpression: NewExpression): string | null {
  if (newExpression.callee.kind !== "Identifier") {
    return null;
  }
  const baseName = (newExpression.callee as Identifier).name;
  const typeArguments = (newExpression.typeArguments ?? []).map((typeArgument) => typeArgument.name);
  if (typeArguments.length > 0) {
    return `${baseName}<${typeArguments.join(", ")}>`;
  }
  return baseName;
}

function inferredTypeNameLosesGenericArguments(typeName: string | null): boolean {
  if (!typeName) {
    return true;
  }
  return /<\s*any(?:\s*,\s*any)*\s*>$/.test(typeName);
}

function declaredInitializerTypeName(
  declarationNode: Identifier,
  ast: Program
): string | null {
  let resolvedTypeName: string | null = null;
  walkAst(ast, (node) => {
    if (resolvedTypeName !== null || node.kind !== "VarStatement") {
      return;
    }
    const varStatement = node as VarStatement;
    const candidates = varStatement.declarations?.length
      ? varStatement.declarations
      : [varStatement];
    for (const candidate of candidates) {
      const bindingName = candidate.kind === "VarDeclarator"
        ? (candidate as VarDeclarator).name
        : (candidate as VarStatement).name;
      const initializer = candidate.kind === "VarDeclarator"
        ? (candidate as VarDeclarator).initializer
        : (candidate as VarStatement).initializer;
      if (!bindingIdentifiers(bindingName).some((identifier) => identifier === declarationNode)) {
        continue;
      }
      resolvedTypeName = initializer?.kind === "NewExpression"
        ? explicitTypeNameFromNewExpression(initializer as NewExpression)
        : null;
      break;
    }
  });
  return resolvedTypeName;
}

export function constructorParameterProperties(classStatement: ClassStatement): FunctionParameter[] {
  return classStatement.members
    .filter((member) => member.kind === "ClassMethodMember" && member.name.name === "constructor")
    .flatMap((member) => member.kind === "ClassMethodMember" ? member.parameters : [])
    .filter((parameter) => parameter.accessModifier !== undefined || parameter.readonly === true);
}

export function classPropertyParameters(classStatement: ClassStatement) {
  return [...(classStatement.primaryConstructorParameters ?? []), ...constructorParameterProperties(classStatement)];
}

function resolveClassOwnMember(
  classStatement: ClassStatement,
  memberName: string,
  substitutions: Map<string, string>
): ResolvedClassMember | null {
  for (const parameter of classPropertyParameters(classStatement)) {
    if (bindingNameText(parameter.name) !== memberName) {
      continue;
    }
    const typeName = substituteTypeNameText(parameter.typeAnnotation?.name ?? "unknown", substitutions);
    const documentation = parameter.name.kind === "Identifier" ? readDocumentationFromIdentifier(parameter.name) : undefined;
    const result: ResolvedClassMember = {
      className: classStatement.name.name,
      memberName,
      kind: "field",
      typeName
    };
    if (documentation) {
      result.documentation = documentation;
    }
    return result;
  }

  for (const member of classStatement.members) {
    if (member.name.name !== memberName) {
      continue;
    }
    if (member.kind === "ClassFieldMember") {
      const documentation = readDocumentationFromIdentifier(member.name);
      const result: ResolvedClassMember = {
        className: classStatement.name.name,
        memberName,
        kind: "field",
        typeName: substituteTypeNameText(member.typeAnnotation?.name ?? "unknown", substitutions)
      };
      if (documentation) {
        result.documentation = documentation;
      }
      return result;
    }

    if (member.accessorKind === "get") {
      const documentation = readDocumentationFromIdentifier(member.name);
      const result: ResolvedClassMember = {
        className: classStatement.name.name,
        memberName,
        kind: "field",
        typeName: substituteTypeNameText(member.returnType?.name ?? "unknown", substitutions)
      };
      if (documentation) {
        result.documentation = documentation;
      }
      return result;
    }

    if (member.accessorKind === "set") {
      const documentation = readDocumentationFromIdentifier(member.name);
      const result: ResolvedClassMember = {
        className: classStatement.name.name,
        memberName,
        kind: "field",
        typeName: substituteTypeNameText(member.parameters[0]?.typeAnnotation?.name ?? "unknown", substitutions)
      };
      if (documentation) {
        result.documentation = documentation;
      }
      return result;
    }

    const parameters: ResolvedParameter[] = member.parameters.map((parameter) => ({
      name: bindingNameText(parameter.name),
      typeName: substituteTypeNameText(parameter.typeAnnotation?.name ?? "unknown", substitutions),
      optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
      rest: parameter.rest === true
    }));
    const returnTypeName = substituteTypeNameText(member.returnType?.name ?? "void", substitutions);
    const documentation = readDocumentationFromIdentifier(member.name);
    const signature: ResolvedFunctionSignature = {
      name: member.name.name,
      parameters,
      returnTypeName,
      ...(documentation ? { documentation } : {})
    };
    return {
      className: classStatement.name.name,
      memberName,
      kind: "method",
      typeName: `(${parameters.map((parameter) => `${parameter.rest ? "..." : ""}${parameter.name}: ${parameter.typeName}`).join(", ")}) => ${returnTypeName}`,
      signature,
      ...(documentation ? { documentation } : {})
    };
  }

  return null;
}

function classOwnMemberKind(
  classStatement: ClassStatement,
  memberName: string
): "field" | "method" | null {
  for (const parameter of classPropertyParameters(classStatement)) {
    if (bindingNameText(parameter.name) === memberName) {
      return "field";
    }
  }
  for (const member of classStatement.members) {
    if (member.name.name !== memberName) {
      continue;
    }
    return member.kind === "ClassFieldMember" || member.accessorKind ? "field" : "method";
  }
  return null;
}

function resolveInterfaceOwnMember(
  interfaceStatement: InterfaceStatement,
  memberName: string,
  substitutions: Map<string, string>
): ResolvedClassMember | null {
  for (const member of interfaceStatement.members) {
    if (member.name.name !== memberName) {
      continue;
    }

    if (member.kind === "InterfacePropertyMember") {
      const documentation = readDocumentationFromIdentifier(member.name);
      const result: ResolvedClassMember = {
        className: interfaceStatement.name.name,
        memberName,
        kind: "field",
        typeName: substituteTypeNameText(member.typeAnnotation?.name ?? "unknown", substitutions)
      };
      if (documentation) {
        result.documentation = documentation;
      }
      return result;
    }

    const parameters: ResolvedParameter[] = member.parameters.map((parameter) => ({
      name: bindingNameText(parameter.name),
      typeName: substituteTypeNameText(parameter.typeAnnotation?.name ?? "unknown", substitutions),
      optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
      rest: parameter.rest === true
    }));
    const returnTypeName = substituteTypeNameText(member.returnType?.name ?? "void", substitutions);
    const documentation = readDocumentationFromIdentifier(member.name);
    const signature: ResolvedFunctionSignature = {
      name: member.name.name,
      parameters,
      returnTypeName,
      ...(documentation ? { documentation } : {})
    };
    return {
      className: interfaceStatement.name.name,
      memberName,
      kind: "method",
      typeName: `(${parameters.map((parameter) => `${parameter.rest ? "..." : ""}${parameter.name}: ${parameter.typeName}`).join(", ")}) => ${returnTypeName}`,
      signature,
      ...(documentation ? { documentation } : {})
    };
  }

  return null;
}

async function resolveInterfaceMemberRecursive(
  interfaceStatement: InterfaceStatement,
  memberName: string,
  objectTypeName: string | undefined,
  context: ResolutionContext,
  visitedInterfaces: Set<string>
): Promise<ResolvedClassMember | null> {
  const cacheKey = interfaceMemberCacheKey(interfaceStatement.name.name, memberName, objectTypeName);
  const cached = context.cache.interfaceMemberByRequest.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const visitKey = `${interfaceStatement.name.name}|${objectTypeName ?? "<none>"}`;
  if (visitedInterfaces.has(visitKey)) {
    context.cache.interfaceMemberByRequest.set(cacheKey, null);
    return null;
  }
  visitedInterfaces.add(visitKey);

  const substitutions = typeParameterSubstitutions(
    interfaceStatement.typeParameters ?? [],
    objectTypeName
  );

  const local = resolveInterfaceOwnMember(interfaceStatement, memberName, substitutions);
  if (local) {
    context.cache.interfaceMemberByRequest.set(cacheKey, local);
    return local;
  }

  for (const parentType of interfaceStatement.extendsTypes ?? []) {
    const specializedParentType = substituteTypeNameText(parentType.name, substitutions);
    const parentResolution = await resolveInterfaceStatementAcrossFiles(
      context.ast,
      baseTypeName(specializedParentType),
      context.options,
      context.cache
    );
    if (!parentResolution) {
      continue;
    }
    const resolved = await resolveInterfaceMemberRecursive(
      parentResolution.interfaceStatement,
      memberName,
      specializedParentType,
      context,
      visitedInterfaces
    );
    if (resolved) {
      context.cache.interfaceMemberByRequest.set(cacheKey, resolved);
      return resolved;
    }
  }

  context.cache.interfaceMemberByRequest.set(cacheKey, null);
  return null;
}

async function resolveClassMemberRecursive(
  classStatement: ClassStatement,
  memberName: string,
  objectTypeName: string | undefined,
  context: ResolutionContext,
  visitedClasses: Set<string>,
  visitedInterfaces: Set<string>
): Promise<ResolvedClassMember | null> {
  const cacheKey = classMemberCacheKey(classStatement.name.name, memberName, objectTypeName);
  const cached = context.cache.classMemberByRequest.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const visitKey = `${classStatement.name.name}|${objectTypeName ?? "<none>"}`;
  if (visitedClasses.has(visitKey)) {
    context.cache.classMemberByRequest.set(cacheKey, null);
    return null;
  }
  visitedClasses.add(visitKey);

  const substitutions = typeParameterSubstitutions(classStatement.typeParameters ?? [], objectTypeName);
  const local = resolveClassOwnMember(classStatement, memberName, substitutions);
  if (local) {
    context.cache.classMemberByRequest.set(cacheKey, local);
    return local;
  }

  if (classStatement.extendsType) {
    const specializedParentType = substituteTypeNameText(classStatement.extendsType.name, substitutions);
    const parentResolution = await resolveClassStatementAcrossFiles(
      context.ast,
      baseTypeName(specializedParentType),
      context.options,
      context.cache
    );
    if (parentResolution) {
      const resolved = await resolveClassMemberRecursive(
        parentResolution.classStatement,
        memberName,
        specializedParentType,
        context,
        visitedClasses,
        visitedInterfaces
      );
      if (resolved) {
        context.cache.classMemberByRequest.set(cacheKey, resolved);
        return resolved;
      }
    }
  }

  for (const implementedType of classStatement.implementsTypes ?? []) {
    const specializedInterfaceType = substituteTypeNameText(implementedType.name, substitutions);
    const interfaceResolution = await resolveInterfaceStatementAcrossFiles(
      context.ast,
      baseTypeName(specializedInterfaceType),
      context.options,
      context.cache
    );
    if (!interfaceResolution) {
      continue;
    }
    const resolved = await resolveInterfaceMemberRecursive(
      interfaceResolution.interfaceStatement,
      memberName,
      specializedInterfaceType,
      context,
      visitedInterfaces
    );
    if (resolved) {
      context.cache.classMemberByRequest.set(cacheKey, resolved);
      return resolved;
    }
  }

  context.cache.classMemberByRequest.set(cacheKey, null);
  return null;
}

export async function resolveClassMember(
  classStatement: ClassStatement,
  memberName: string,
  objectTypeName?: string,
  context?: ResolveClassMemberContext
): Promise<ResolvedClassMember | null> {
  if (!context) {
    const substitutions = typeParameterSubstitutions(
      classStatement.typeParameters ?? [],
      objectTypeName
    );
    return resolveClassOwnMember(classStatement, memberName, substitutions);
  }

  return resolveClassMemberRecursive(
    classStatement,
    memberName,
    objectTypeName,
    {
      ast: context.ast,
      options: context.options,
      cache: context.cache ?? createClassResolverCache()
    },
    new Set<string>(),
    new Set<string>()
  );
}

export async function resolveInterfaceMember(
  interfaceStatement: InterfaceStatement,
  memberName: string,
  objectTypeName?: string,
  context?: ResolveClassMemberContext
): Promise<ResolvedClassMember | null> {
  if (!context) {
    const substitutions = typeParameterSubstitutions(
      interfaceStatement.typeParameters ?? [],
      objectTypeName
    );
    return resolveInterfaceOwnMember(interfaceStatement, memberName, substitutions);
  }

  return resolveInterfaceMemberRecursive(
    interfaceStatement,
    memberName,
    objectTypeName,
    {
      ast: context.ast,
      options: context.options,
      cache: context.cache ?? createClassResolverCache()
    },
    new Set<string>()
  );
}

async function resolveClassMemberDeclarationRecursive(
  classResolution: ResolvedClassStatement,
  memberName: string,
  objectTypeName: string | undefined,
  context: ResolutionContext,
  visitedClasses: Set<string>
): Promise<ResolvedClassMemberDeclaration | null> {
  const classStatement = classResolution.classStatement;
  const visitKey = `${classStatement.name.name}|${objectTypeName ?? "<none>"}`;
  if (visitedClasses.has(visitKey)) {
    return null;
  }
  visitedClasses.add(visitKey);

  const ownMemberKind = classOwnMemberKind(classStatement, memberName);
  if (ownMemberKind) {
    return {
      classStatement,
      filePath: classResolution.filePath,
      memberName,
      kind: ownMemberKind
    };
  }

  const substitutions = typeParameterSubstitutions(classStatement.typeParameters ?? [], objectTypeName);
  if (!classStatement.extendsType) {
    return null;
  }
  const specializedParentType = substituteTypeNameText(classStatement.extendsType.name, substitutions);
  const parentResolution = await resolveClassStatementAcrossFiles(
    context.ast,
    baseTypeName(specializedParentType),
    context.options,
    context.cache
  );
  if (!parentResolution) {
    return null;
  }

  return resolveClassMemberDeclarationRecursive(
    parentResolution,
    memberName,
    specializedParentType,
    context,
    visitedClasses
  );
}

export async function resolveClassMemberDeclaration(
  classResolution: ResolvedClassStatement,
  memberName: string,
  objectTypeName: string | undefined,
  context: ResolveClassMemberContext
): Promise<ResolvedClassMemberDeclaration | null> {
  return resolveClassMemberDeclarationRecursive(
    classResolution,
    memberName,
    objectTypeName,
    {
      ast: context.ast,
      options: context.options,
      cache: context.cache ?? createClassResolverCache()
    },
    new Set<string>()
  );
}

function addUniqueMemberName(names: string[], seen: Set<string>, memberName: string): void {
  if (seen.has(memberName)) {
    return;
  }
  seen.add(memberName);
  names.push(memberName);
}

async function collectInterfaceMemberNamesRecursive(
  interfaceStatement: InterfaceStatement,
  objectTypeName: string | undefined,
  context: ResolutionContext,
  visitedInterfaces: Set<string>,
  names: string[],
  seenNames: Set<string>
): Promise<void> {
  const visitKey = `${interfaceStatement.name.name}|${objectTypeName ?? "<none>"}`;
  if (visitedInterfaces.has(visitKey)) {
    return;
  }
  visitedInterfaces.add(visitKey);

  for (const member of interfaceStatement.members) {
    addUniqueMemberName(names, seenNames, member.name.name);
  }

  const substitutions = typeParameterSubstitutions(
    interfaceStatement.typeParameters ?? [],
    objectTypeName
  );
  for (const parentType of interfaceStatement.extendsTypes ?? []) {
    const specializedParentType = substituteTypeNameText(parentType.name, substitutions);
    const parentResolution = await resolveInterfaceStatementAcrossFiles(
      context.ast,
      baseTypeName(specializedParentType),
      context.options,
      context.cache
    );
    if (!parentResolution) {
      continue;
    }
    await collectInterfaceMemberNamesRecursive(
      parentResolution.interfaceStatement,
      specializedParentType,
      context,
      visitedInterfaces,
      names,
      seenNames
    );
  }
}

async function collectClassMemberNamesRecursive(
  classStatement: ClassStatement,
  objectTypeName: string | undefined,
  context: ResolutionContext,
  visitedClasses: Set<string>,
  visitedInterfaces: Set<string>,
  names: string[],
  seenNames: Set<string>
): Promise<void> {
  const visitKey = `${classStatement.name.name}|${objectTypeName ?? "<none>"}`;
  if (visitedClasses.has(visitKey)) {
    return;
  }
  visitedClasses.add(visitKey);

  for (const parameter of classPropertyParameters(classStatement)) {
    addUniqueMemberName(names, seenNames, bindingNameText(parameter.name));
  }
  for (const member of classStatement.members) {
    addUniqueMemberName(names, seenNames, member.name.name);
  }

  const substitutions = typeParameterSubstitutions(classStatement.typeParameters ?? [], objectTypeName);

  if (classStatement.extendsType) {
    const specializedParentType = substituteTypeNameText(classStatement.extendsType.name, substitutions);
    const parentResolution = await resolveClassStatementAcrossFiles(
      context.ast,
      baseTypeName(specializedParentType),
      context.options,
      context.cache
    );
    if (parentResolution) {
      await collectClassMemberNamesRecursive(
        parentResolution.classStatement,
        specializedParentType,
        context,
        visitedClasses,
        visitedInterfaces,
        names,
        seenNames
      );
    }
  }

  for (const implementedType of classStatement.implementsTypes ?? []) {
    const specializedInterfaceType = substituteTypeNameText(implementedType.name, substitutions);
    const interfaceResolution = await resolveInterfaceStatementAcrossFiles(
      context.ast,
      baseTypeName(specializedInterfaceType),
      context.options,
      context.cache
    );
    if (!interfaceResolution) {
      continue;
    }
    await collectInterfaceMemberNamesRecursive(
      interfaceResolution.interfaceStatement,
      specializedInterfaceType,
      context,
      visitedInterfaces,
      names,
      seenNames
    );
  }
}

export async function resolveClassMemberNames(
  classStatement: ClassStatement,
  objectTypeName?: string,
  context?: ResolveClassMemberContext
): Promise<string[]> {
  const names: string[] = [];
  const seenNames = new Set<string>();

  if (!context) {
    for (const parameter of classPropertyParameters(classStatement)) {
      addUniqueMemberName(names, seenNames, bindingNameText(parameter.name));
    }
    for (const member of classStatement.members) {
      addUniqueMemberName(names, seenNames, member.name.name);
    }
    return names;
  }

  await collectClassMemberNamesRecursive(
    classStatement,
    objectTypeName,
    {
      ast: context.ast,
      options: context.options,
      cache: context.cache ?? createClassResolverCache()
    },
    new Set<string>(),
    new Set<string>(),
    names,
    seenNames
  );
  return names;
}

export async function resolveInterfaceMemberNames(
  interfaceStatement: InterfaceStatement,
  objectTypeName: string | undefined,
  context: ResolveClassMemberContext
): Promise<string[]> {
  const names: string[] = [];
  const seenNames = new Set<string>();
  await collectInterfaceMemberNamesRecursive(
    interfaceStatement,
    objectTypeName,
    {
      ast: context.ast,
      options: context.options,
      cache: context.cache ?? createClassResolverCache()
    },
    new Set<string>(),
    names,
    seenNames
  );
  return names;
}

async function resolveInterfaceMemberDeclarationRecursive(
  interfaceResolution: ResolvedInterfaceStatement,
  memberName: string,
  objectTypeName: string | undefined,
  context: ResolutionContext,
  visitedInterfaces: Set<string>
): Promise<ResolvedTypeMemberDeclaration | null> {
  const interfaceStatement = interfaceResolution.interfaceStatement;
  const visitKey = `${interfaceStatement.name.name}|${objectTypeName ?? "<none>"}`;
  if (visitedInterfaces.has(visitKey)) {
    return null;
  }
  visitedInterfaces.add(visitKey);

  for (const member of interfaceStatement.members) {
    if (member.name.name === memberName) {
      return {
        declaration: interfaceStatement,
        filePath: interfaceResolution.filePath,
        memberName,
        kind: member.kind === "InterfacePropertyMember" ? "field" : "method"
      };
    }
  }

  const substitutions = typeParameterSubstitutions(interfaceStatement.typeParameters ?? [], objectTypeName);
  for (const parentType of interfaceStatement.extendsTypes ?? []) {
    const specializedParentType = substituteTypeNameText(parentType.name, substitutions);
    const parentResolution = await resolveInterfaceStatementAcrossFiles(
      context.ast,
      baseTypeName(specializedParentType),
      context.options,
      context.cache
    );
    if (!parentResolution) {
      continue;
    }
    const resolved = await resolveInterfaceMemberDeclarationRecursive(
      parentResolution,
      memberName,
      specializedParentType,
      context,
      visitedInterfaces
    );
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

export async function resolveInterfaceMemberDeclaration(
  interfaceResolution: ResolvedInterfaceStatement,
  memberName: string,
  objectTypeName: string | undefined,
  context: ResolveClassMemberContext
): Promise<ResolvedTypeMemberDeclaration | null> {
  return resolveInterfaceMemberDeclarationRecursive(
    interfaceResolution,
    memberName,
    objectTypeName,
    {
      ast: context.ast,
      options: context.options,
      cache: context.cache ?? createClassResolverCache()
    },
    new Set<string>()
  );
}

export function isTypeAssignableByName(sourceType: string, targetType: string): boolean {
  if (sourceType === targetType) {
    return true;
  }
  if (sourceType === "int" && targetType === "number") {
    return true;
  }
  if (sourceType === "long" && targetType === "bigint") {
    return true;
  }
  if (
    targetType === "numeric" &&
    (sourceType === "int" || sourceType === "number" || sourceType === "long" || sourceType === "bigint")
  ) {
    return true;
  }
  return false;
}

export async function resolveExpressionTypeName(
  expression: Expr,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions
): Promise<string | null> {
  const direct = typeNameFromAnalysisType(analysis.getExpressionTypes().get(expression));
  if (direct && direct !== "unknown" && !(expression.kind === "Identifier" && inferredTypeNameLosesGenericArguments(direct))) {
    return direct;
  }

  if (expression.kind === "AsExpression") {
    const assertion = expression as AsExpression;
    return typeNameFromAnalysisType(analysis.getExpressionTypes().get(assertion))
      ?? assertion.typeAnnotation.name
      ?? await resolveExpressionTypeName(assertion.expression, analysis, ast, options);
  }

  if (expression.kind === "NonNullExpression") {
    const nonNull = expression as NonNullExpression;
    return typeNameFromAnalysisType(analysis.getExpressionTypes().get(nonNull))
      ?? await resolveExpressionTypeName(nonNull.expression, analysis, ast, options);
  }

  if (expression.kind === "Identifier") {
    const firstToken = expression.firstToken;
    if (!firstToken) {
      return null;
    }
    const symbol = analysis.getSymbolAt(firstToken.range.start.line, firstToken.range.start.column)?.symbol;
    const symbolTypeName = typeNameFromAnalysisType(symbol?.type);
    if (!inferredTypeNameLosesGenericArguments(symbolTypeName)) {
      return symbolTypeName;
    }
    if (symbol?.node.kind === "Identifier") {
      return declaredInitializerTypeName(symbol.node as Identifier, ast) ?? symbolTypeName;
    }
    return symbolTypeName;
  }

  if (expression.kind === "NewExpression") {
    return explicitTypeNameFromNewExpression(expression as NewExpression);
  }

  if (expression.kind === "CallExpression") {
    const call = expression as CallExpression;
    const callable = await resolveCallableSignature(call.callee, analysis, ast, options);
    return callable?.returnTypeName ?? null;
  }

  if (expression.kind === "AssignmentExpression") {
    return await resolveExpressionTypeName((expression as AssignmentExpression).right, analysis, ast, options);
  }

  if (expression.kind === "UnaryExpression") {
    const unary = expression as UnaryExpression;
    if (unary.operator === "!") {
      return "boolean";
    }
    if (unary.operator === "typeof") {
      return "string";
    }
    if (unary.operator === "void") {
      return "undefined";
    }
    if (unary.operator === "delete") {
      return "boolean";
    }
    if (unary.operator === "await") {
      return await resolveExpressionTypeName(unary.argument, analysis, ast, options);
    }
    return await resolveExpressionTypeName(unary.argument, analysis, ast, options);
  }

  if (expression.kind === "UpdateExpression") {
    const argumentType = await resolveExpressionTypeName(
      (expression as UpdateExpression).argument,
      analysis,
      ast,
      options
    );
    return argumentType ?? "int";
  }

  if (expression.kind === "ConditionalExpression") {
    const conditional = expression as ConditionalExpression;
    const consequentType = await resolveExpressionTypeName(conditional.consequent, analysis, ast, options);
    const alternateType = await resolveExpressionTypeName(conditional.alternate, analysis, ast, options);
    if (consequentType && consequentType === alternateType) {
      return consequentType;
    }
    return consequentType ?? alternateType ?? null;
  }

  if (expression.kind === "RangeExpression") {
    return "range<int>";
  }

  if (expression.kind === "BinaryExpression") {
    const binary = expression as BinaryExpression;
    const left = await resolveExpressionTypeName(binary.left, analysis, ast, options);
    const right = await resolveExpressionTypeName(binary.right, analysis, ast, options);
    if (binary.operator === "+" && (left === "string" || right === "string")) {
      return "string";
    }
    if (
      [
        "<",
        ">",
        "<=",
        ">=",
        "in",
        "instanceof",
        "==",
        "!=",
        "===",
        "!==",
        "||",
        "&&"
      ].includes(binary.operator)
    ) {
      return "boolean";
    }
  }

  if (expression.kind !== "MemberExpression") {
    return null;
  }

  const member = expression as MemberExpression;
  if (member.computed || member.property.kind !== "Identifier") {
    return null;
  }

  const objectTypeName = await resolveExpressionTypeName(member.object, analysis, ast, options);
  const parsedObjectType = objectTypeName ? parseTypeNameShape(objectTypeName) : null;
  if (!parsedObjectType || BUILTIN_TYPE_NAMES.has(parsedObjectType.baseName)) {
    return null;
  }

  const resolverCache = createClassResolverCache();
  const classResolution = await resolveClassStatementAcrossFiles(
    ast,
    parsedObjectType.baseName,
    options,
    resolverCache
  );
  if (!classResolution) {
    return null;
  }
  const memberResolution = await resolveClassMember(
    classResolution.classStatement,
    (member.property as Identifier).name,
    objectTypeName ?? undefined,
    {
      ast,
      options,
      cache: resolverCache
    }
  );
  if (!memberResolution) {
    return null;
  }
  if (memberResolution.kind === "method") {
    return memberResolution.signature?.returnTypeName ?? null;
  }
  return memberResolution.typeName;
}

async function findNodeModuleNamespaceBody(
  ast: Program,
  typeName: string,
  importerFilePath: string,
  options: ClassResolverOptions
): Promise<Statement[] | null> {
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") continue;
    const importStatement = statement as ImportStatement;
    if (importStatement.from.value.startsWith(".")) continue;
    const typings = await getNodeModuleTypings(importerFilePath, importStatement.from.value, { vfs: options.vfs });
    if (!typings || typings.defaultExportName !== typeName) continue;
    for (const decl of typings.declarations) {
      const candidate =
        decl.kind === "ExportStatement"
          ? (decl as { declaration?: Statement }).declaration ?? decl
          : decl;
      if (
        candidate.kind === "NamespaceStatement" &&
        (candidate as NamespaceStatement).names?.[0]?.name === typeName
      ) {
        return (candidate as NamespaceStatement).body.body;
      }
    }
  }
  return null;
}

async function resolveNodeModuleNamespaceFunctionSignature(
  ast: Program,
  typeName: string,
  memberName: string,
  importerFilePath: string,
  options: ClassResolverOptions
): Promise<ResolvedFunctionSignature | null> {
  const nsBody = await findNodeModuleNamespaceBody(ast, typeName, importerFilePath, options);
  if (!nsBody) return null;

  for (const bodyStmt of nsBody) {
    const candidate =
      bodyStmt.kind === "ExportStatement"
        ? (bodyStmt as { declaration?: Statement }).declaration ?? bodyStmt
        : bodyStmt;
    if (candidate.kind !== "FunctionStatement") continue;
    const fn = candidate as FunctionStatement;
    if (fn.name?.name !== memberName) continue;
    const parameters: ResolvedParameter[] = fn.parameters
      .filter((p) => !p.thisParameter)
      .map((p) => ({
        name: bindingNameText(p.name),
        typeName: p.typeAnnotation?.name ?? "unknown",
        optional: p.optional === true || p.defaultValue !== undefined || p.rest === true,
        rest: p.rest === true
      }));
    return {
      name: memberName,
      parameters,
      returnTypeName: fn.returnType?.name ?? "unknown"
    };
  }
  return null;
}

export async function resolveCallableSignature(
  callee: Expr,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions
): Promise<ResolvedFunctionSignature | null> {
  if (callee.kind === "Identifier") {
    const identifier = callee as Identifier;
    if (!identifier.firstToken) {
      return null;
    }
    const symbol = analysis.getSymbolAt(
      identifier.firstToken.range.start.line,
      identifier.firstToken.range.start.column
    )?.symbol;
    if (!symbol) {
      return null;
    }
    if (symbol.type?.kind === "function") {
      const documentation =
        symbol.node.kind === "Identifier"
          ? readDocumentationFromProgramDeclaration(ast, symbol.node as Identifier)
          : undefined;
      return {
        name: identifier.name,
        parameters: symbol.type.parameters.map((parameter) => ({
          name: parameter.name,
          typeName: typeToString(parameter.type),
          optional: parameter.optional === true,
          rest: parameter.rest === true
        })),
        returnTypeName: typeToString(symbol.type.returnType),
        ...(documentation ? { documentation } : {})
      };
    }
    return null;
  }

  if (callee.kind !== "MemberExpression") {
    return null;
  }

  const member = callee as MemberExpression;
  if (member.computed || member.property.kind !== "Identifier") {
    return null;
  }

  const objectTypeName = await resolveExpressionTypeName(member.object, analysis, ast, options);
  const parsedObjectType = objectTypeName ? parseTypeNameShape(objectTypeName) : null;
  if (!parsedObjectType || BUILTIN_TYPE_NAMES.has(parsedObjectType.baseName)) {
    return null;
  }

  const resolverCache = createClassResolverCache();
  const memberName = (member.property as Identifier).name;
  const memberContext = { ast, options, cache: resolverCache };

  const classResolution = await resolveClassStatementAcrossFiles(
    ast,
    parsedObjectType.baseName,
    options,
    resolverCache
  );
  if (classResolution) {
    const memberResolution = await resolveClassMember(
      classResolution.classStatement,
      memberName,
      objectTypeName ?? undefined,
      memberContext
    );
    if (memberResolution && memberResolution.kind === "method" && memberResolution.signature) {
      return memberResolution.signature;
    }
  }

  // The receiver may be typed by an interface rather than a class. This covers
  // ambient runtime globals such as `Math` and constructor objects like `Date`
  // (typed `declare var Date: DateConstructor`), whose static-style members
  // live on the (constructor) interface.
  const interfaceResolution = await resolveInterfaceStatementAcrossFiles(
    ast,
    parsedObjectType.baseName,
    options,
    resolverCache
  );
  if (interfaceResolution) {
    const memberResolution = await resolveInterfaceMember(
      interfaceResolution.interfaceStatement,
      memberName,
      objectTypeName ?? undefined,
      memberContext
    );
    if (memberResolution && memberResolution.kind === "method" && memberResolution.signature) {
      return memberResolution.signature;
    }
  }

  // Fallback: look for the member in a node_modules namespace declaration.
  const importerFilePath = options.uri ? uriToFilePath(options.uri) : null;
  if (importerFilePath) {
    const nodeModuleSig = await resolveNodeModuleNamespaceFunctionSignature(
      ast,
      parsedObjectType.baseName,
      memberName,
      importerFilePath,
      options
    );
    if (nodeModuleSig) return nodeModuleSig;
  }

  return null;
}

export async function resolveConstructorSignature(
  callee: Expr,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions
): Promise<ResolvedConstructorSignature | null> {
  if (callee.kind !== "Identifier") {
    return null;
  }

  const identifier = callee as Identifier;
  if (!identifier.firstToken) {
    return null;
  }

  const classResolution = await resolveClassStatementAcrossFiles(
    ast,
    identifier.name,
    options,
    createClassResolverCache()
  );
  if (classResolution) {
    return {
      className: classResolution.classStatement.name.name,
      parameters: (classResolution.classStatement.primaryConstructorParameters ?? []).map((parameter) => ({
        name: bindingNameText(parameter.name),
        typeName: parameter.typeAnnotation?.name ?? "unknown",
        optional: parameter.defaultValue !== undefined
      }))
    };
  }

  const symbol = analysis.getSymbolAt(
    identifier.firstToken.range.start.line,
    identifier.firstToken.range.start.column
  )?.symbol;
  const className = symbol?.kind === "class"
    ? symbol.name
    : symbol?.valueType
      ? baseTypeName(symbol.valueType)
      : symbol?.type
        ? baseTypeName(typeToString(symbol.type))
        : null;
  if (!className) {
    return null;
  }

  const resolvedClass = await resolveClassStatementAcrossFiles(
    ast,
    className,
    options,
    createClassResolverCache()
  );
  if (!resolvedClass) {
    return null;
  }

  return {
    className,
    parameters: (resolvedClass.classStatement.primaryConstructorParameters ?? []).map((parameter: {
      name: Identifier;
      typeAnnotation?: Identifier;
      defaultValue?: Expr;
    }) => ({
      name: bindingNameText(parameter.name),
      typeName: parameter.typeAnnotation?.name ?? "unknown",
      optional: parameter.defaultValue !== undefined
    }))
  };
}
