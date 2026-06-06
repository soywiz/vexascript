import { bindingNameText } from "compiler/ast/bindingPatterns";
import type { Analysis } from "compiler/analysis/Analysis";
import { baseTypeName, parseTypeNameShape, substituteTypeNameText } from "compiler/analysis/typeNames";
import { type AnalysisType, typeToString } from "compiler/analysis/types";
import type {
  AsExpression,
  AssignmentExpression,
  BinaryExpression,
  CallExpression,
  ClassStatement,
  InterfaceStatement,
  ConditionalExpression,
  Expr,
  FunctionParameter,
  Identifier,
  MemberExpression,
  NewExpression,
  NonNullExpression,
  UnaryExpression,
  UpdateExpression,
  Program
} from "compiler/ast/ast";
import { uriToFilePath } from "./importFixes";
import {
  findTopLevelDeclarationInProgram,
  isClassStatement,
  isInterfaceStatement,
  resolveTopLevelDeclarationAcrossFiles
} from "./declarationResolver";
import {
  type ProjectContext,
  type ProjectSessionLike
} from "./projectAnalysis";

const BUILTIN_TYPE_NAMES = new Set([
  "int",
  "number",
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

interface ResolvedInterfaceStatement {
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

export function resolveClassStatementAcrossFiles(
  ast: Program,
  className: string,
  options: ClassResolverOptions,
  cache?: ClassResolverCache
): ResolvedClassStatement | null {
  const resolverCache = cache ?? createClassResolverCache();
  const cached = resolverCache.classStatementByName.get(className);
  if (cached !== undefined) {
    return cached;
  }

  const resolved = resolveTopLevelDeclarationAcrossFiles({
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

function resolveInterfaceStatementAcrossFiles(
  ast: Program,
  interfaceName: string,
  options: ClassResolverOptions,
  cache: ClassResolverCache
): ResolvedInterfaceStatement | null {
  const cached = cache.interfaceStatementByName.get(interfaceName);
  if (cached !== undefined) {
    return cached;
  }

  const resolved = resolveTopLevelDeclarationAcrossFiles({
    ast,
    name: interfaceName,
    currentFilePath: options.uri ? uriToFilePath(options.uri) : null,
    predicate: isInterfaceStatement,
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

function readDocumentationFromIdentifier(identifier: Identifier): string | undefined {
  const comments = identifier.firstToken?.leadingComments;
  if (!comments || comments.length === 0) {
    return undefined;
  }

  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (!comment || comment.kind !== "block" || !comment.value.startsWith("/**")) {
      continue;
    }

    const withoutMarkers = comment.value
      .replace(/^\/\*\*/, "")
      .replace(/\*\/$/, "");
    const lines = withoutMarkers
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd());
    const normalized = lines.join("\n").trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return undefined;
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

function resolveInterfaceMemberRecursive(
  interfaceStatement: InterfaceStatement,
  memberName: string,
  objectTypeName: string | undefined,
  context: ResolutionContext,
  visitedInterfaces: Set<string>
): ResolvedClassMember | null {
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
    const parentResolution = resolveInterfaceStatementAcrossFiles(
      context.ast,
      baseTypeName(specializedParentType),
      context.options,
      context.cache
    );
    if (!parentResolution) {
      continue;
    }
    const resolved = resolveInterfaceMemberRecursive(
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

function resolveClassMemberRecursive(
  classStatement: ClassStatement,
  memberName: string,
  objectTypeName: string | undefined,
  context: ResolutionContext,
  visitedClasses: Set<string>,
  visitedInterfaces: Set<string>
): ResolvedClassMember | null {
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
    const parentResolution = resolveClassStatementAcrossFiles(
      context.ast,
      baseTypeName(specializedParentType),
      context.options,
      context.cache
    );
    if (parentResolution) {
      const resolved = resolveClassMemberRecursive(
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
    const interfaceResolution = resolveInterfaceStatementAcrossFiles(
      context.ast,
      baseTypeName(specializedInterfaceType),
      context.options,
      context.cache
    );
    if (!interfaceResolution) {
      continue;
    }
    const resolved = resolveInterfaceMemberRecursive(
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

export function resolveClassMember(
  classStatement: ClassStatement,
  memberName: string,
  objectTypeName?: string,
  context?: ResolveClassMemberContext
): ResolvedClassMember | null {
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

function resolveClassMemberDeclarationRecursive(
  classResolution: ResolvedClassStatement,
  memberName: string,
  objectTypeName: string | undefined,
  context: ResolutionContext,
  visitedClasses: Set<string>
): ResolvedClassMemberDeclaration | null {
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
  const parentResolution = resolveClassStatementAcrossFiles(
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

export function resolveClassMemberDeclaration(
  classResolution: ResolvedClassStatement,
  memberName: string,
  objectTypeName: string | undefined,
  context: ResolveClassMemberContext
): ResolvedClassMemberDeclaration | null {
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

function collectInterfaceMemberNamesRecursive(
  interfaceStatement: InterfaceStatement,
  objectTypeName: string | undefined,
  context: ResolutionContext,
  visitedInterfaces: Set<string>,
  names: string[],
  seenNames: Set<string>
): void {
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
    const parentResolution = resolveInterfaceStatementAcrossFiles(
      context.ast,
      baseTypeName(specializedParentType),
      context.options,
      context.cache
    );
    if (!parentResolution) {
      continue;
    }
    collectInterfaceMemberNamesRecursive(
      parentResolution.interfaceStatement,
      specializedParentType,
      context,
      visitedInterfaces,
      names,
      seenNames
    );
  }
}

function collectClassMemberNamesRecursive(
  classStatement: ClassStatement,
  objectTypeName: string | undefined,
  context: ResolutionContext,
  visitedClasses: Set<string>,
  visitedInterfaces: Set<string>,
  names: string[],
  seenNames: Set<string>
): void {
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
    const parentResolution = resolveClassStatementAcrossFiles(
      context.ast,
      baseTypeName(specializedParentType),
      context.options,
      context.cache
    );
    if (parentResolution) {
      collectClassMemberNamesRecursive(
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
    const interfaceResolution = resolveInterfaceStatementAcrossFiles(
      context.ast,
      baseTypeName(specializedInterfaceType),
      context.options,
      context.cache
    );
    if (!interfaceResolution) {
      continue;
    }
    collectInterfaceMemberNamesRecursive(
      interfaceResolution.interfaceStatement,
      specializedInterfaceType,
      context,
      visitedInterfaces,
      names,
      seenNames
    );
  }
}

export function resolveClassMemberNames(
  classStatement: ClassStatement,
  objectTypeName?: string,
  context?: ResolveClassMemberContext
): string[] {
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

  collectClassMemberNamesRecursive(
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
  return false;
}

export function resolveExpressionTypeName(
  expression: Expr,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions
): string | null {
  const direct = typeNameFromAnalysisType(analysis.getExpressionTypes().get(expression));
  if (direct && direct !== "unknown") {
    return direct;
  }

  if (expression.kind === "AsExpression") {
    const assertion = expression as AsExpression;
    return typeNameFromAnalysisType(analysis.getExpressionTypes().get(assertion))
      ?? assertion.typeAnnotation.name
      ?? resolveExpressionTypeName(assertion.expression, analysis, ast, options);
  }

  if (expression.kind === "NonNullExpression") {
    const nonNull = expression as NonNullExpression;
    return typeNameFromAnalysisType(analysis.getExpressionTypes().get(nonNull))
      ?? resolveExpressionTypeName(nonNull.expression, analysis, ast, options);
  }

  if (expression.kind === "Identifier") {
    const firstToken = expression.firstToken;
    if (!firstToken) {
      return null;
    }
    const symbol = analysis.getSymbolAt(firstToken.range.start.line, firstToken.range.start.column)?.symbol;
    return typeNameFromAnalysisType(symbol?.type);
  }

  if (expression.kind === "NewExpression") {
    const newExpression = expression as NewExpression;
    if (newExpression.callee.kind === "Identifier") {
      const baseName = (newExpression.callee as Identifier).name;
      const typeArguments = (newExpression.typeArguments ?? []).map((typeArgument) => typeArgument.name);
      if (typeArguments.length > 0) {
        return `${baseName}<${typeArguments.join(", ")}>`;
      }
      return baseName;
    }
    return null;
  }

  if (expression.kind === "CallExpression") {
    const call = expression as CallExpression;
    const callable = resolveCallableSignature(call.callee, analysis, ast, options);
    return callable?.returnTypeName ?? null;
  }

  if (expression.kind === "AssignmentExpression") {
    return resolveExpressionTypeName((expression as AssignmentExpression).right, analysis, ast, options);
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
      return resolveExpressionTypeName(unary.argument, analysis, ast, options);
    }
    return resolveExpressionTypeName(unary.argument, analysis, ast, options);
  }

  if (expression.kind === "UpdateExpression") {
    const argumentType = resolveExpressionTypeName(
      (expression as UpdateExpression).argument,
      analysis,
      ast,
      options
    );
    return argumentType ?? "int";
  }

  if (expression.kind === "ConditionalExpression") {
    const conditional = expression as ConditionalExpression;
    const consequentType = resolveExpressionTypeName(conditional.consequent, analysis, ast, options);
    const alternateType = resolveExpressionTypeName(conditional.alternate, analysis, ast, options);
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
    const left = resolveExpressionTypeName(binary.left, analysis, ast, options);
    const right = resolveExpressionTypeName(binary.right, analysis, ast, options);
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

  const objectTypeName = resolveExpressionTypeName(member.object, analysis, ast, options);
  const parsedObjectType = objectTypeName ? parseTypeNameShape(objectTypeName) : null;
  if (!parsedObjectType || BUILTIN_TYPE_NAMES.has(parsedObjectType.baseName)) {
    return null;
  }

  const resolverCache = createClassResolverCache();
  const classResolution = resolveClassStatementAcrossFiles(
    ast,
    parsedObjectType.baseName,
    options,
    resolverCache
  );
  if (!classResolution) {
    return null;
  }
  const memberResolution = resolveClassMember(
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

export function resolveCallableSignature(
  callee: Expr,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions
): ResolvedFunctionSignature | null {
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
      return {
        name: identifier.name,
        parameters: symbol.type.parameters.map((parameter) => ({
          name: parameter.name,
          typeName: typeToString(parameter.type),
          optional: parameter.optional === true,
          rest: parameter.rest === true
        })),
        returnTypeName: typeToString(symbol.type.returnType)
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

  const objectTypeName = resolveExpressionTypeName(member.object, analysis, ast, options);
  const parsedObjectType = objectTypeName ? parseTypeNameShape(objectTypeName) : null;
  if (!parsedObjectType || BUILTIN_TYPE_NAMES.has(parsedObjectType.baseName)) {
    return null;
  }

  const resolverCache = createClassResolverCache();
  const classResolution = resolveClassStatementAcrossFiles(
    ast,
    parsedObjectType.baseName,
    options,
    resolverCache
  );
  if (!classResolution) {
    return null;
  }

  const memberResolution = resolveClassMember(
    classResolution.classStatement,
    (member.property as Identifier).name,
    objectTypeName ?? undefined,
    {
      ast,
      options,
      cache: resolverCache
    }
  );
  if (!memberResolution || memberResolution.kind !== "method" || !memberResolution.signature) {
    return null;
  }

  return memberResolution.signature;
}

export function resolveConstructorSignature(
  callee: Expr,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions
): ResolvedConstructorSignature | null {
  if (callee.kind !== "Identifier") {
    return null;
  }

  const identifier = callee as Identifier;
  if (!identifier.firstToken) {
    return null;
  }

  const classResolution = resolveClassStatementAcrossFiles(
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

  const resolvedClass = resolveClassStatementAcrossFiles(
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
