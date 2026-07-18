import { bindingNameText } from "compiler/ast/bindingPatterns";
import type { Analysis } from "compiler/analysis/Analysis";
import {
  baseTypeName,
  boxedPrimitiveTypeName,
  parseObjectTypeAnnotation,
  parseTypeNameShape,
  splitTopLevelTypeText,
  stripEnclosingTypeParens,
  substituteTypeNameText
} from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
import {
  AsExpression,
  AssignmentExpression,
  BinaryExpression,
  CallExpression,
  ClassStatement,
  ExportStatement,
  FunctionStatement,
  ImportStatement,
  InterfaceStatement,
  InterfaceMethodMember,
  NamespaceStatement,
  ConditionalExpression,
  Expr,
  FunctionParameter,
  Identifier,
  MemberExpression,
  NewExpression,
  NonNullExpression,
  SatisfiesExpression,
  Statement,
  UnaryExpression,
  UpdateExpression,
  Program,
} from "compiler/ast/ast";
import { getNodeModuleTypings } from "./nodeModulesTypings";
import { uriToFilePath } from "./importFixes";
import { readDocumentationForSymbol } from "./documentation";
import {
  findTopLevelDeclarationInProgram,
  isClassStatement,
  isInterfaceStatement,
  resolveTopLevelDeclarationAcrossFiles
} from "./declarationResolver";
import { getEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations";
import { ensureDomProgram, getDomDeclarationFilePath } from "compiler/runtime/domDeclarations";
import {
  declaredInitializerTypeName,
  explicitTypeNameFromNewExpression,
  inferredTypeNameLosesGenericArguments,
  typeNameFromAnalysisType
} from "./classResolverTypeNames";
import {
  classOwnMemberKind,
  resolveClassOwnMember,
  resolveInterfaceOwnMember,
  resolveInterfaceOwnSignatures
} from "./classResolverMemberShapes";
import {
  type ProjectContext,
  type ProjectSessionLike
} from "./projectAnalysis";
import { resolveNodeModulesTypingsPath } from "compiler/moduleResolution";

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
  ambientDeclarations?: Statement[];
  ambientModuleDeclarations?: ReadonlyMap<string, Statement[]>;
  /**
   * The session's selectively-collected external declarations. Signature help
   * uses these to detect an in-scope extension member that shadows a class
   * member, so it can prefer the extension's signature like the other surfaces.
   */
  externalDeclarations?: readonly Statement[];
  classResolverCache?: ClassResolverCache;
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
  deprecated?: boolean;
}

export interface ResolvedClassMember {
  className: string;
  memberName: string;
  kind: "field" | "method";
  typeName: string;
  signature?: ResolvedFunctionSignature;
  documentation?: string;
  deprecated?: boolean;
}

export interface ResolvedClassMemberDeclaration {
  declaration: ClassStatement | InterfaceStatement;
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
  analysis?: Analysis;
  cache?: ClassResolverCache;
}

interface ResolutionContext {
  ast: Program;
  options: ClassResolverOptions;
  analysis?: Analysis;
  cache: ClassResolverCache;
}

function createResolutionContext(context: ResolveClassMemberContext): ResolutionContext {
  return {
    ast: context.ast,
    options: context.options,
    cache: context.cache ?? createClassResolverCache(),
    ...(context.analysis ? { analysis: context.analysis } : {})
  };
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
  typeParameters: Array<{ name: Identifier; defaultType?: Identifier }> | undefined,
  objectTypeName: string | undefined
): Map<string, string> {
  const substitutions = new Map<string, string>();
  if (!objectTypeName) {
    for (const parameter of typeParameters ?? []) {
      substitutions.set(parameter.name.name, parameter.defaultType?.name ?? parameter.name.name);
    }
    return substitutions;
  }

  const parsedObjectType = parseTypeNameShape(objectTypeName);
  const declaredTypeParameters = typeParameters ?? [];
  for (let i = 0; i < declaredTypeParameters.length; i += 1) {
    const typeParameter = declaredTypeParameters[i];
    const parameterName = typeParameter?.name.name;
    if (!parameterName) {
      continue;
    }
    substitutions.set(parameterName, parsedObjectType.typeArguments[i] ?? typeParameter?.defaultType?.name ?? parameterName);
  }

  return substitutions;
}

function identityTypeParameterSubstitutions(
  typeParameters: Array<{ name: Identifier }> | undefined
): Map<string, string> {
  const substitutions = new Map<string, string>();
  for (const parameter of typeParameters ?? []) {
    substitutions.set(parameter.name.name, parameter.name.name);
  }
  return substitutions;
}

function unwrapSingleTypeArgument(typeName: string, wrapperName: string): string | null {
  if (baseTypeName(typeName) !== wrapperName) {
    return null;
  }
  const parsed = parseTypeNameShape(typeName);
  return parsed.typeArguments.length === 1 ? parsed.typeArguments[0] ?? null : null;
}

function inferTypeParameterFromMemberTypes(
  parameterName: string,
  parentMemberTypeName: string,
  childMemberTypeName: string
): string | null {
  const normalizedParentTypeName = stripEnclosingTypeParens(parentMemberTypeName.trim());
  if (normalizedParentTypeName === parameterName) {
    return childMemberTypeName;
  }
  for (const wrapperName of ["Readonly", "Partial"]) {
    const wrappedArgument = unwrapSingleTypeArgument(normalizedParentTypeName, wrapperName);
    if (wrappedArgument === parameterName) {
      return childMemberTypeName;
    }
  }
  return null;
}

async function parentMemberTemplateTypeName(
  parentClassStatement: ClassStatement,
  parentInterfaceStatement: InterfaceStatement | null,
  memberName: string
): Promise<string | null> {
  if (parentInterfaceStatement) {
    const interfaceMember = resolveInterfaceOwnMember(
      parentInterfaceStatement,
      memberName,
      identityTypeParameterSubstitutions(parentInterfaceStatement.typeParameters ?? [])
    );
    if (interfaceMember?.typeName && interfaceMember.typeName !== "unknown") {
      return interfaceMember.typeName;
    }
  }

  const classMember = resolveClassOwnMember(
    parentClassStatement,
    memberName,
    identityTypeParameterSubstitutions(parentClassStatement.typeParameters ?? []),
    classPropertyParameters
  );
  return classMember?.typeName && classMember.typeName !== "unknown" ? classMember.typeName : null;
}

async function specializeInheritedParentTypeFromChild(
  childClassStatement: ClassStatement,
  parentTypeName: string,
  parentClassStatement: ClassStatement,
  context: ResolutionContext
): Promise<string> {
  const parsedParentType = parseTypeNameShape(parentTypeName);
  if (parsedParentType.typeArguments.length > 0) {
    return parentTypeName;
  }

  const parentTypeParameters = parentClassStatement.typeParameters ?? [];
  if (parentTypeParameters.length === 0) {
    return parentTypeName;
  }

  const parentInterfaceResolution = await resolveInterfaceStatementAcrossFiles(
    context.ast,
    parentClassStatement.name.name,
    context.options,
    context.cache
  );
  const parentInterfaceStatement = parentInterfaceResolution?.interfaceStatement ?? null;

  const defaults = new Map<string, string>();
  for (let index = 0; index < parentTypeParameters.length; index += 1) {
    const parameter = parentTypeParameters[index];
    const interfaceParameter = parentInterfaceStatement?.typeParameters?.[index];
    const defaultTypeName = parameter?.defaultType?.name ?? interfaceParameter?.defaultType?.name;
    if (parameter && defaultTypeName) {
      defaults.set(parameter.name.name, defaultTypeName);
    }
  }

  const inferred = new Map<string, string>();
  const ownFieldNames = new Set<string>(classPropertyParameters(childClassStatement).map((parameter) => bindingNameText(parameter.name)));
  for (const member of childClassStatement.members) {
    if (member.kind === "ClassFieldMember") {
      ownFieldNames.add(member.name.name);
    }
  }

  for (const childMemberName of ownFieldNames) {
    const childMember = await resolveClassMember(childClassStatement, childMemberName, childClassStatement.name.name, {
      ast: context.ast,
      options: context.options,
      cache: context.cache,
      ...(context.analysis ? { analysis: context.analysis } : {})
    });
    if (!childMember || childMember.kind !== "field" || childMember.typeName === "unknown") {
      continue;
    }

    const parentMemberTypeName = await parentMemberTemplateTypeName(
      parentClassStatement,
      parentInterfaceStatement,
      childMemberName
    );
    if (!parentMemberTypeName) {
      continue;
    }

    for (const parameter of parentTypeParameters) {
      const parameterName = parameter.name.name;
      if (inferred.has(parameterName)) {
        continue;
      }
      const inferredTypeName = inferTypeParameterFromMemberTypes(
        parameterName,
        parentMemberTypeName,
        childMember.typeName
      );
      if (inferredTypeName) {
        inferred.set(parameterName, inferredTypeName);
      }
    }
  }

  const resolvedTypeArguments = parentTypeParameters.map((parameter) =>
    inferred.get(parameter.name.name) ?? defaults.get(parameter.name.name) ?? parameter.name.name
  );
  const changed = resolvedTypeArguments.some((typeArgument, index) => typeArgument !== parentTypeParameters[index]?.name.name);
  if (!changed) {
    return parentTypeName;
  }
  return `${baseTypeName(parentTypeName)}<${resolvedTypeArguments.join(", ")}>`;
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

function findClassStatementInStatements(statements: readonly Statement[] | undefined, className: string): ClassStatement | null {
  if (!statements) {
    return null;
  }
  const syntheticProgram = new Program({ kind: "Program", body: [...statements] }) as Program;
  return findClassStatementInProgram(syntheticProgram, className);
}

function mergeInterfaceStatements(interfaceStatements: InterfaceStatement[]): InterfaceStatement | null {
  const [first, ...rest] = interfaceStatements;
  if (!first) {
    return null;
  }
  return rest.reduce<InterfaceStatement>((merged, current) => {
    const next: InterfaceStatement = {
      ...merged,
      members: [...merged.members, ...current.members],
    };
    const mergedTypeParameters = merged.typeParameters ?? current.typeParameters;
    if (mergedTypeParameters) {
      next.typeParameters = mergedTypeParameters;
    }
    const mergedExtendsTypes = [
      ...(merged.extendsTypes ?? []),
      ...(current.extendsTypes ?? [])
    ];
    if (mergedExtendsTypes.length > 0) {
      next.extendsTypes = mergedExtendsTypes;
    }
    return next;
  }, first);
}

function findMergedInterfaceStatementInProgram(ast: Program, interfaceName: string): InterfaceStatement | null {
  const matches: InterfaceStatement[] = [];
  for (const statement of ast.body) {
    const declaration = statement.kind === "ExportStatement"
      ? (statement as ExportStatement).declaration
      : statement;
    if (!declaration || declaration.kind !== "InterfaceStatement") {
      continue;
    }
    const interfaceStatement = declaration as InterfaceStatement;
    if (interfaceStatement.name.name === interfaceName) {
      matches.push(interfaceStatement);
    }
  }
  return mergeInterfaceStatements(matches);
}

function findMergedInterfaceStatementInStatements(
  statements: readonly Statement[] | undefined,
  interfaceName: string
): InterfaceStatement | null {
  if (!statements) {
    return null;
  }
  const syntheticProgram = new Program({ kind: "Program", body: [...statements] }) as Program;
  return findMergedInterfaceStatementInProgram(syntheticProgram, interfaceName);
}

function findMergedQualifiedInterfaceStatementInStatements(
  statements: readonly Statement[],
  path: string[]
): InterfaceStatement | null {
  const interfaceName = path.at(-1);
  if (!interfaceName) {
    return null;
  }
  if (path.length === 1) {
    return mergeInterfaceStatements(
      statements.flatMap((statement) => {
        const declaration = statement.kind === "ExportStatement"
          ? (statement as ExportStatement).declaration
          : statement;
        if (!declaration || declaration.kind !== "InterfaceStatement") {
          return [];
        }
        const interfaceStatement = declaration as InterfaceStatement;
        return interfaceStatement.name.name === interfaceName ? [interfaceStatement] : [];
      })
    );
  }

  const [namespaceName, ...rest] = path;
  const nestedMatches = statements.flatMap((statement) => {
    const declaration = statement.kind === "ExportStatement"
      ? (statement as ExportStatement).declaration
      : statement;
    if (!declaration || declaration.kind !== "NamespaceStatement") {
      return [];
    }
    const namespaceStatement = declaration as NamespaceStatement;
    if (namespaceStatement.names?.[0]?.name === namespaceName) {
      const resolved = findMergedQualifiedInterfaceStatementInStatements(namespaceStatement.body.body, rest);
      return resolved ? [resolved] : [];
    }
    const nestedResolved = findMergedQualifiedInterfaceStatementInStatements(namespaceStatement.body.body, path);
    return nestedResolved ? [nestedResolved] : [];
  });

  return mergeInterfaceStatements(nestedMatches);
}

function findMergedQualifiedInterfaceStatementInProgram(ast: Program, interfaceName: string): InterfaceStatement | null {
  return findMergedQualifiedInterfaceStatementInStatements(ast.body, interfaceName.split("."));
}

async function resolveNodeModuleImportedClassStatement(
  ast: Program,
  className: string,
  options: ClassResolverOptions
): Promise<ResolvedClassStatement | null> {
  const importerFilePath = options.uri ? uriToFilePath(options.uri) : null;
  if (!importerFilePath) {
    return null;
  }

  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    if (importStatement.from.value.startsWith(".")) {
      continue;
    }
    const typings = await getNodeModuleTypings(importerFilePath, importStatement.from.value, { vfs: options.vfs });
    if (!typings) {
      continue;
    }

    for (const entry of typings.declarationEntries) {
      const declaration = entry.statement.kind === "ExportStatement"
        ? (entry.statement as ExportStatement).declaration
        : entry.statement;
      if (!declaration || declaration.kind !== "ClassStatement") {
        continue;
      }
      const classStatement = declaration as ClassStatement;
      if (classStatement.name.name !== className) {
        continue;
      }
      return {
        classStatement,
        filePath: entry.typingsPath
      };
    }
  }

  return null;
}

async function resolveNodeModuleImportedInterfaceStatement(
  ast: Program,
  interfaceName: string,
  options: ClassResolverOptions
): Promise<ResolvedInterfaceStatement | null> {
  const importerFilePath = options.uri ? uriToFilePath(options.uri) : null;
  if (!importerFilePath) {
    return null;
  }

  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    if (importStatement.from.value.startsWith(".")) {
      continue;
    }
    const typingsPath = await resolveNodeModulesTypingsPath(importerFilePath, importStatement.from.value, { vfs: options.vfs });
    const typings = await getNodeModuleTypings(importerFilePath, importStatement.from.value, { vfs: options.vfs });
    if (!typings || !typingsPath) {
      continue;
    }
    const syntheticProgram: Program = new Program({ kind: "Program", body: typings.declarations });
    const declaration = interfaceName.includes(".")
      ? findMergedQualifiedInterfaceStatementInProgram(syntheticProgram, interfaceName)
      : findMergedInterfaceStatementInProgram(syntheticProgram, interfaceName);
    if (declaration) {
      return {
        interfaceStatement: declaration,
        filePath: typingsPath
      };
    }
  }

  return null;
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

  const ambientClassStatement = resolved ? null : findClassStatementInStatements(options.ambientDeclarations, className);
  const classStatement = resolved
    ? {
        classStatement: resolved.declaration,
        filePath: resolved.filePath
      }
    : ambientClassStatement
      ? {
          classStatement: ambientClassStatement,
          filePath: ""
        }
      : await resolveNodeModuleImportedClassStatement(ast, className, options);
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

  if (interfaceName.includes(".")) {
    const localQualifiedInterface = findMergedQualifiedInterfaceStatementInProgram(ast, interfaceName);
    const qualifiedResolution = localQualifiedInterface
      ? {
          interfaceStatement: localQualifiedInterface,
          filePath: options.uri ? (uriToFilePath(options.uri) ?? "") : ""
        }
      : await resolveNodeModuleImportedInterfaceStatement(ast, interfaceName, options);
    cache.interfaceStatementByName.set(interfaceName, qualifiedResolution);
    return qualifiedResolution;
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

  let mergedInterfaceStatement: InterfaceStatement | null = null;
  let resolvedFilePath: string | null = null;
  if (resolved) {
    const currentFilePath = options.uri ? uriToFilePath(options.uri) : null;
    if (resolved.filePath === currentFilePath) {
      mergedInterfaceStatement = findMergedInterfaceStatementInProgram(ast, interfaceName);
    } else if (resolved.filePath === "") {
      mergedInterfaceStatement = findMergedInterfaceStatementInProgram(getEcmaScriptRuntimeProgram(), interfaceName);
    } else if (resolved.filePath === getDomDeclarationFilePath()) {
      mergedInterfaceStatement = findMergedInterfaceStatementInProgram(await ensureDomProgram(), interfaceName);
    } else if (options.getSessionForFilePath) {
      const targetSession = await options.getSessionForFilePath(resolved.filePath);
      if (targetSession?.ast) {
        mergedInterfaceStatement = findMergedInterfaceStatementInProgram(targetSession.ast, interfaceName);
      }
    }
    resolvedFilePath = resolved.filePath;
  } else {
    const localInterfaceStatement = findMergedInterfaceStatementInProgram(ast, interfaceName);
    if (localInterfaceStatement) {
      mergedInterfaceStatement = localInterfaceStatement;
      resolvedFilePath = options.uri ? uriToFilePath(options.uri) : null;
    } else {
      const ambientInterfaceStatement = findMergedInterfaceStatementInStatements(options.ambientDeclarations, interfaceName);
      if (ambientInterfaceStatement) {
        mergedInterfaceStatement = ambientInterfaceStatement;
        resolvedFilePath = "";
      } else {
        const ecmaScriptInterfaceStatement = findMergedInterfaceStatementInProgram(getEcmaScriptRuntimeProgram(), interfaceName);
        if (ecmaScriptInterfaceStatement) {
          mergedInterfaceStatement = ecmaScriptInterfaceStatement;
          resolvedFilePath = "";
        } else {
          const domInterfaceStatement = findMergedInterfaceStatementInProgram(await ensureDomProgram(), interfaceName);
          if (domInterfaceStatement) {
            mergedInterfaceStatement = domInterfaceStatement;
            resolvedFilePath = getDomDeclarationFilePath();
          }
        }
      }
    }
  }

  const interfaceStatement = resolved || mergedInterfaceStatement
    ? {
        interfaceStatement: mergedInterfaceStatement ?? resolved!.declaration,
        filePath: resolvedFilePath ?? ""
      }
    : await resolveNodeModuleImportedInterfaceStatement(ast, interfaceName, options);
  cache.interfaceStatementByName.set(interfaceName, interfaceStatement);
  return interfaceStatement;
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

function resolvedConstructorParameters(classStatement: ClassStatement): ResolvedParameter[] {
  const constructorMember = classStatement.members.find(
    (member): member is ClassStatement["members"][number] =>
      member.kind === "ClassMethodMember" && member.name.name === "constructor"
  );
  const parameters = constructorMember?.kind === "ClassMethodMember"
    ? constructorMember.parameters
    : (classStatement.primaryConstructorParameters ?? []);
  return parameters.map((parameter) => ({
    name: bindingNameText(parameter.name),
    typeName: parameter.typeAnnotation?.name ?? "unknown",
    optional: ("optional" in parameter && parameter.optional === true) || parameter.defaultValue !== undefined || ("rest" in parameter && parameter.rest === true),
    rest: "rest" in parameter && parameter.rest === true
  }));
}

function resolvedInterfaceConstructorParameters(
  interfaceStatement: InterfaceStatement,
  constructorMember: InterfaceMethodMember
): ResolvedParameter[] {
  const substitutions = typeParameterSubstitutions(interfaceStatement.typeParameters ?? [], undefined);
  return constructorMember.parameters.map((parameter) => ({
    name: bindingNameText(parameter.name),
    typeName: substituteTypeNameText(parameter.typeAnnotation?.name ?? "unknown", substitutions),
    optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
    rest: parameter.rest === true
  }));
}

async function selectBestInterfaceConstructorSignature(
  interfaceStatement: InterfaceStatement,
  callExpression: CallExpression | NewExpression | undefined,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions
): Promise<ResolvedConstructorSignature | null> {
  const constructorMembers = interfaceStatement.members.filter(
    (member): member is InterfaceMethodMember =>
      member.kind === "InterfaceMethodMember" && member.name.name === "constructor"
  );
  if (constructorMembers.length === 0) {
    return null;
  }

  if (!callExpression) {
    const fallback = constructorMembers[constructorMembers.length - 1] ?? constructorMembers[0];
    if (!fallback) {
      return null;
    }
    return {
      className: interfaceStatement.name.name,
      parameters: resolvedInterfaceConstructorParameters(interfaceStatement, fallback)
    };
  }

  const argumentTypeNames = await Promise.all(
    (callExpression.arguments ?? []).map((argument) => resolveExpressionTypeName(argument, analysis, ast, options))
  );
  let arityMatchedFallback: ResolvedConstructorSignature | null = null;

  for (const constructorMember of constructorMembers) {
    const parameters = resolvedInterfaceConstructorParameters(interfaceStatement, constructorMember);
    const lastParameter = parameters[parameters.length - 1];
    const restParameter = lastParameter?.rest ? lastParameter : undefined;
    const fixedParameters = restParameter ? parameters.slice(0, -1) : parameters;
    const requiredCount = fixedParameters.filter((parameter) => !parameter.optional).length;
    if (argumentTypeNames.length < requiredCount) {
      continue;
    }
    if (!restParameter && argumentTypeNames.length > fixedParameters.length) {
      continue;
    }
    arityMatchedFallback ??= {
      className: interfaceStatement.name.name,
      parameters
    };

    const allMatch = argumentTypeNames.every((argumentTypeName, index) => {
      const parameter = fixedParameters[index] ?? restParameter;
      if (!parameter || !argumentTypeName || argumentTypeName === "unknown") {
        return true;
      }
      return isTypeAssignableByName(argumentTypeName, parameter.typeName);
    });
    if (!allMatch) {
      continue;
    }

    return {
      className: interfaceStatement.name.name,
      parameters
    };
  }

  if (arityMatchedFallback) {
    return arityMatchedFallback;
  }

  const fallback = constructorMembers[0];
  if (!fallback) {
    return null;
  }
  return {
    className: interfaceStatement.name.name,
    parameters: resolvedInterfaceConstructorParameters(interfaceStatement, fallback)
  };
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
  const local = resolveClassOwnMember(classStatement, memberName, substitutions, classPropertyParameters, {
    ast: context.ast,
    options: context.options,
    cache: context.cache,
    ...(context.analysis ? { analysis: context.analysis } : {})
  });
  if (local) {
    context.cache.classMemberByRequest.set(cacheKey, local);
    return local;
  }

  const mergedInterfaceMember = await resolveMergedClassInterfaceMember(
    classStatement,
    memberName,
    objectTypeName,
    context,
    visitedInterfaces
  );
  if (mergedInterfaceMember) {
    context.cache.classMemberByRequest.set(cacheKey, mergedInterfaceMember);
    return mergedInterfaceMember;
  }

  if (classStatement.extendsType) {
    const parentTypeName = substituteTypeNameText(classStatement.extendsType.name, substitutions);
    const parentResolution = await resolveClassStatementAcrossFiles(
      context.ast,
      baseTypeName(parentTypeName),
      context.options,
      context.cache
    );
    if (parentResolution) {
      const specializedParentType = await specializeInheritedParentTypeFromChild(
        classStatement,
        parentTypeName,
        parentResolution.classStatement,
        context
      );
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
    return resolveClassOwnMember(classStatement, memberName, substitutions, classPropertyParameters);
  }

  return resolveClassMemberRecursive(
    classStatement,
    memberName,
    objectTypeName,
    createResolutionContext(context),
    new Set<string>(),
    new Set<string>()
  );
}

async function resolveMergedClassInterfaceMember(
  classStatement: ClassStatement,
  memberName: string,
  objectTypeName: string | undefined,
  context: ResolutionContext,
  visitedInterfaces: Set<string>
): Promise<ResolvedClassMember | null> {
  const interfaceResolution = await resolveInterfaceStatementAcrossFiles(
    context.ast,
    classStatement.name.name,
    context.options,
    context.cache
  );
  if (!interfaceResolution) {
    return null;
  }
  return resolveInterfaceMemberRecursive(
    interfaceResolution.interfaceStatement,
    memberName,
    objectTypeName,
    context,
    visitedInterfaces
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
    createResolutionContext(context),
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

  const ownMemberKind = classOwnMemberKind(classStatement, memberName, classPropertyParameters);
  if (ownMemberKind) {
    return {
      declaration: classStatement,
      classStatement,
      filePath: classResolution.filePath,
      memberName,
      kind: ownMemberKind
    };
  }

  const mergedInterfaceResolution = await resolveInterfaceStatementAcrossFiles(
    context.ast,
    classStatement.name.name,
    context.options,
    context.cache
  );
  if (mergedInterfaceResolution) {
    const mergedDeclaration = await resolveInterfaceMemberDeclarationRecursive(
      mergedInterfaceResolution,
      memberName,
      objectTypeName,
      context,
      new Set<string>()
    );
    if (mergedDeclaration) {
      return {
        declaration: mergedDeclaration.declaration,
        classStatement,
        filePath: mergedDeclaration.filePath,
        memberName,
        kind: mergedDeclaration.kind
      };
    }
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
    createResolutionContext(context),
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

  const mergedInterfaceResolution = await resolveInterfaceStatementAcrossFiles(
    context.ast,
    classStatement.name.name,
    context.options,
    context.cache
  );
  if (mergedInterfaceResolution) {
    await collectInterfaceMemberNamesRecursive(
      mergedInterfaceResolution.interfaceStatement,
      objectTypeName,
      context,
      visitedInterfaces,
      names,
      seenNames
    );
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
    createResolutionContext(context),
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
    createResolutionContext(context),
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
  const normalizedSourceType = stripEnclosingTypeParens(sourceType.trim());
  const normalizedTargetType = stripEnclosingTypeParens(targetType.trim());

  if (normalizedSourceType !== sourceType || normalizedTargetType !== targetType) {
    return isTypeAssignableByName(normalizedSourceType, normalizedTargetType);
  }

  const targetUnionMembers = splitTopLevelTypeText(normalizedTargetType, "|");
  if (targetUnionMembers.length > 1) {
    return targetUnionMembers.some((member) => isTypeAssignableByName(normalizedSourceType, member));
  }

  const sourceUnionMembers = splitTopLevelTypeText(normalizedSourceType, "|");
  if (sourceUnionMembers.length > 1) {
    return sourceUnionMembers.every((member) => isTypeAssignableByName(member, normalizedTargetType));
  }

  const targetIntersectionMembers = splitTopLevelTypeText(normalizedTargetType, "&");
  if (targetIntersectionMembers.length > 1) {
    return targetIntersectionMembers.every((member) => isTypeAssignableByName(normalizedSourceType, member));
  }

  if (sourceType === targetType) {
    return true;
  }
  const sourceShape = parseTypeNameShape(normalizedSourceType);
  const targetShape = parseTypeNameShape(normalizedTargetType);
  if (targetShape.baseName === "Readonly" && targetShape.typeArguments.length === 1) {
    return isTypeAssignableByName(normalizedSourceType, targetShape.typeArguments[0]!);
  }
  if (targetShape.baseName === "Partial" && targetShape.typeArguments.length === 1) {
    const sourceMembers = parseObjectTypeAnnotation(normalizedSourceType);
    const targetMembers = parseObjectTypeAnnotation(targetShape.typeArguments[0]!);
    if (sourceMembers && targetMembers) {
      return sourceMembers.every((sourceMember) => {
        const targetMember = targetMembers.find((member) => member.name === sourceMember.name);
        return !!targetMember && isTypeAssignableByName(sourceMember.typeName, targetMember.typeName);
      });
    }
  }
  if (
    sourceShape.baseName === targetShape.baseName &&
    sourceShape.arrayDepth === targetShape.arrayDepth &&
    (sourceShape.typeArguments.length > 0 || targetShape.typeArguments.length > 0)
  ) {
    if (sourceShape.typeArguments.length === 0 || targetShape.typeArguments.length === 0) {
      return true;
    }
    if (sourceShape.typeArguments.length === targetShape.typeArguments.length) {
      return sourceShape.typeArguments.every((argument, index) =>
        isTypeAssignableByName(argument, targetShape.typeArguments[index]!)
      );
    }
  }
  if (normalizedSourceType.endsWith("[]") && normalizedTargetType.endsWith("[]")) {
    return isTypeAssignableByName(
      normalizedSourceType.slice(0, -2).trim(),
      normalizedTargetType.slice(0, -2).trim()
    );
  }
  if (normalizedSourceType === "int" && normalizedTargetType === "number") {
    return true;
  }
  if (normalizedSourceType === "long" && normalizedTargetType === "bigint") {
    return true;
  }
  if (
    normalizedTargetType === "numeric" &&
    (
      normalizedSourceType === "int" ||
      normalizedSourceType === "number" ||
      normalizedSourceType === "long" ||
      normalizedSourceType === "bigint"
    )
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

  if (expression.kind === "SatisfiesExpression") {
    const satisfies = expression as SatisfiesExpression;
    return typeNameFromAnalysisType(analysis.getExpressionTypes().get(satisfies))
      ?? await resolveExpressionTypeName(satisfies.expression, analysis, ast, options);
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

  const resolverCache = options.classResolverCache ?? createClassResolverCache();
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
          ? readDocumentationForSymbol(ast, symbol.node as Identifier, {
            ambientModuleDeclarations: options.ambientModuleDeclarations
            })
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
    const classResolution = await resolveClassStatementAcrossFiles(
      ast,
      identifier.name,
      options,
      options.classResolverCache ?? createClassResolverCache()
    );
    if (classResolution) {
      return {
        name: identifier.name,
        parameters: resolvedConstructorParameters(classResolution.classStatement),
        returnTypeName: classResolution.classStatement.name.name
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
  if (!parsedObjectType) {
    return null;
  }
  const resolvedBaseTypeName = boxedPrimitiveTypeName(parsedObjectType.baseName);

  const resolverCache = options.classResolverCache ?? createClassResolverCache();
  const memberName = (member.property as Identifier).name;
  const memberContext = { ast, options, cache: resolverCache };

  const classResolution = await resolveClassStatementAcrossFiles(
    ast,
    resolvedBaseTypeName,
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
    resolvedBaseTypeName,
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
      resolvedBaseTypeName,
      memberName,
      importerFilePath,
      options
    );
    if (nodeModuleSig) return nodeModuleSig;
  }

  return null;
}

export async function resolveCallableSignatures(
  callee: Expr,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions
): Promise<ResolvedFunctionSignature[]> {
  if (callee.kind === "Identifier") {
    const identifier = callee as Identifier;
    if (!identifier.firstToken) return [];
    const symbol = analysis.getSymbolAt(
      identifier.firstToken.range.start.line,
      identifier.firstToken.range.start.column
    )?.symbol;
    if (!symbol) return [];
    const documentation =
      symbol.node.kind === "Identifier"
        ? readDocumentationForSymbol(ast, symbol.node as Identifier, {
            ambientModuleDeclarations: options.ambientModuleDeclarations
          })
        : undefined;
    if (symbol.type?.kind === "function") {
      return [{
        name: identifier.name,
        parameters: symbol.type.parameters.map((parameter) => ({
          name: parameter.name,
          typeName: typeToString(parameter.type),
          optional: parameter.optional === true,
          rest: parameter.rest === true
        })),
        returnTypeName: typeToString(symbol.type.returnType),
        ...(documentation ? { documentation } : {})
      }];
    }
    if (symbol.type?.kind === "union") {
      const sigs: ResolvedFunctionSignature[] = [];
      for (const t of symbol.type.types) {
        if (t.kind !== "function") continue;
        sigs.push({
          name: identifier.name,
          parameters: t.parameters.map((parameter) => ({
            name: parameter.name,
            typeName: typeToString(parameter.type),
            optional: parameter.optional === true,
            rest: parameter.rest === true
          })),
          returnTypeName: typeToString(t.returnType),
          ...(documentation ? { documentation } : {})
        });
      }
      if (sigs.length > 0) return sigs;
    }
    const classResolution = await resolveClassStatementAcrossFiles(
      ast,
      identifier.name,
      options,
      options.classResolverCache ?? createClassResolverCache()
    );
    if (classResolution) {
      return [{
        name: identifier.name,
        parameters: resolvedConstructorParameters(classResolution.classStatement),
        returnTypeName: classResolution.classStatement.name.name
      }];
    }
    return [];
  }

  if (callee.kind !== "MemberExpression") return [];
  const member = callee as MemberExpression;
  if (member.computed || member.property.kind !== "Identifier") return [];

  const objectTypeName = await resolveExpressionTypeName(member.object, analysis, ast, options);
  const parsedObjectType = objectTypeName ? parseTypeNameShape(objectTypeName) : null;
  if (!parsedObjectType) return [];
  const resolvedBaseTypeName = boxedPrimitiveTypeName(parsedObjectType.baseName);

  const resolverCache = options.classResolverCache ?? createClassResolverCache();
  const memberName = (member.property as Identifier).name;
  const memberContext = { ast, options, cache: resolverCache };

  const classResolution = await resolveClassStatementAcrossFiles(ast, resolvedBaseTypeName, options, resolverCache);
  if (classResolution) {
    const memberResolution = await resolveClassMember(
      classResolution.classStatement, memberName, objectTypeName ?? undefined, memberContext
    );
    if (memberResolution?.kind === "method" && memberResolution.signature) {
      return [memberResolution.signature];
    }
  }

  const interfaceResolution = await resolveInterfaceStatementAcrossFiles(
    ast, resolvedBaseTypeName, options, resolverCache
  );
  if (interfaceResolution) {
    const substitutions = typeParameterSubstitutions(
      interfaceResolution.interfaceStatement.typeParameters ?? [],
      objectTypeName ?? undefined
    );
    const overloads = resolveInterfaceOwnSignatures(
      interfaceResolution.interfaceStatement, memberName, substitutions
    );
    if (overloads.length > 0) {
      return overloads.map((o) => o.signature);
    }
  }

  const importerFilePath = options.uri ? uriToFilePath(options.uri) : null;
  if (importerFilePath) {
    const nodeModuleSig = await resolveNodeModuleNamespaceFunctionSignature(
      ast, resolvedBaseTypeName, memberName, importerFilePath, options
    );
    if (nodeModuleSig) return [nodeModuleSig];
  }

  return [];
}

export async function resolveConstructorSignature(
  callee: Expr,
  analysis: Analysis,
  ast: Program,
  options: ClassResolverOptions,
  callExpression?: CallExpression | NewExpression
): Promise<ResolvedConstructorSignature | null> {
  if (callee.kind !== "Identifier") {
    return null;
  }

  const identifier = callee as Identifier;
  if (!identifier.firstToken) {
    return null;
  }

  const symbol = analysis.getSymbolAt(
    identifier.firstToken.range.start.line,
    identifier.firstToken.range.start.column
  )?.symbol;
  if (symbol?.type?.kind === "function") {
    return null;
  }
  if (symbol?.valueType?.includes("=>")) {
    return null;
  }
  const symbolConstructorInterfaceName = symbol?.kind === "class"
    ? null
    : symbol?.valueType
      ? baseTypeName(symbol.valueType)
      : symbol?.type
        ? baseTypeName(typeToString(symbol.type))
        : null;
  if (symbolConstructorInterfaceName) {
    const runtimeSymbolInterface = findMergedInterfaceStatementInProgram(
      getEcmaScriptRuntimeProgram(),
      symbolConstructorInterfaceName
    );
    if (runtimeSymbolInterface) {
      const interfaceConstructorSignature = await selectBestInterfaceConstructorSignature(
        runtimeSymbolInterface,
        callExpression,
        analysis,
        ast,
        options
      );
      if (interfaceConstructorSignature) {
        return interfaceConstructorSignature;
      }
    }

    const symbolInterfaceResolution = await resolveInterfaceStatementAcrossFiles(
      ast,
      symbolConstructorInterfaceName,
      options,
      options.classResolverCache ?? createClassResolverCache()
    );
    if (symbolInterfaceResolution) {
      const interfaceConstructorSignature = await selectBestInterfaceConstructorSignature(
        symbolInterfaceResolution.interfaceStatement,
        callExpression,
        analysis,
        ast,
        options
      );
      if (interfaceConstructorSignature) {
        return interfaceConstructorSignature;
      }
    }
  }

  const classResolution = await resolveClassStatementAcrossFiles(
    ast,
    identifier.name,
    options,
    options.classResolverCache ?? createClassResolverCache()
  );
  if (classResolution) {
    return {
      className: classResolution.classStatement.name.name,
      parameters: resolvedConstructorParameters(classResolution.classStatement)
    };
  }

  const runtimeConstructorInterface = findMergedInterfaceStatementInProgram(
    getEcmaScriptRuntimeProgram(),
    `${identifier.name}Constructor`
  );
  if (runtimeConstructorInterface) {
    const interfaceConstructorSignature = await selectBestInterfaceConstructorSignature(
      runtimeConstructorInterface,
      callExpression,
      analysis,
      ast,
      options
    );
    if (interfaceConstructorSignature) {
      return interfaceConstructorSignature;
    }
  }

  const directInterfaceResolution = await resolveInterfaceStatementAcrossFiles(
    ast,
    `${identifier.name}Constructor`,
    options,
    options.classResolverCache ?? createClassResolverCache()
  );
  if (directInterfaceResolution) {
    const interfaceConstructorSignature = await selectBestInterfaceConstructorSignature(
      directInterfaceResolution.interfaceStatement,
      callExpression,
      analysis,
      ast,
      options
    );
    if (interfaceConstructorSignature) {
      return interfaceConstructorSignature;
    }
  }

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
    options.classResolverCache ?? createClassResolverCache()
  );
  if (resolvedClass) {
    return {
      className,
      parameters: resolvedConstructorParameters(resolvedClass.classStatement)
    };
  }

  const runtimeInterfaceStatement = findMergedInterfaceStatementInProgram(
    getEcmaScriptRuntimeProgram(),
    className
  );
  if (runtimeInterfaceStatement) {
    return selectBestInterfaceConstructorSignature(
      runtimeInterfaceStatement,
      callExpression,
      analysis,
      ast,
      options
    );
  }

  const resolvedInterface = await resolveInterfaceStatementAcrossFiles(
    ast,
    className,
    options,
    options.classResolverCache ?? createClassResolverCache()
  );
  if (!resolvedInterface) {
    return null;
  }

  return selectBestInterfaceConstructorSignature(
    resolvedInterface.interfaceStatement,
    callExpression,
    analysis,
    ast,
    options
  );
}
