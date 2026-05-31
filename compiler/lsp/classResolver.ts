import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type { Analysis } from "compiler/analysis/Analysis";
import { type AnalysisType, typeToString } from "compiler/analysis/types";
import type {
  CallExpression,
  ClassStatement,
  Expr,
  Identifier,
  ImportStatement,
  MemberExpression,
  NewExpression,
  Program
} from "compiler/ast/ast";
import { compileSource } from "compiler/pipeline/compile";
import { uriToFilePath } from "./importFixes";

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

export interface ClassResolverSessionLike {
  ast: Program | null;
  analysis: Analysis | null;
}

export interface ClassResolverOptions {
  uri?: string;
  sourceRoots?: string[];
  getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null;
}

export interface ResolvedClassStatement {
  classStatement: ClassStatement;
  filePath: string;
}

export interface ResolvedParameter {
  name: string;
  typeName: string;
  optional: boolean;
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

function resolveImportTargetFilePath(importerFilePath: string, importPath: string): string | null {
  const baseDir = dirname(importerFilePath);
  const direct = resolve(baseDir, importPath);
  if (existsSync(direct)) {
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

function scanMyFiles(sourceRoots: string[]): string[] {
  const files: string[] = [];
  const stack = [...sourceRoots];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !existsSync(current)) {
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && extname(entry.name) === ".my") {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function getSessionForFilePath(
  filePath: string,
  options: ClassResolverOptions
): ClassResolverSessionLike | null {
  if (options.getSessionForFilePath) {
    const provided = options.getSessionForFilePath(filePath);
    if (provided) {
      return provided;
    }
  }

  if (!existsSync(filePath)) {
    return null;
  }

  const source = readFileSync(filePath, "utf8");
  const compiled = compileSource(source);
  return {
    ast: compiled.ast,
    analysis: compiled.analysis
  };
}

export function findClassStatementInProgram(ast: Program, className: string): ClassStatement | null {
  for (const statement of ast.body) {
    if (statement.kind !== "ClassStatement") {
      continue;
    }
    const classStatement = statement as ClassStatement;
    if (classStatement.name.name === className) {
      return classStatement;
    }
  }
  return null;
}

export function resolveClassStatementAcrossFiles(
  ast: Program,
  className: string,
  options: ClassResolverOptions
): ResolvedClassStatement | null {
  const currentFilePath = options.uri ? uriToFilePath(options.uri) : null;
  const local = findClassStatementInProgram(ast, className);
  if (local) {
    return {
      classStatement: local,
      filePath: currentFilePath ?? ""
    };
  }

  if (currentFilePath) {
    for (const statement of ast.body) {
      if (statement.kind !== "ImportStatement") {
        continue;
      }
      const importStatement = statement as ImportStatement;
      if (!importStatement.specifiers.some((specifier) => specifier.imported.name === className)) {
        continue;
      }
      const targetFilePath = resolveImportTargetFilePath(currentFilePath, importStatement.from.value);
      if (!targetFilePath) {
        continue;
      }
      const targetSession = getSessionForFilePath(targetFilePath, options);
      if (!targetSession?.ast) {
        continue;
      }
      const targetClass = findClassStatementInProgram(targetSession.ast, className);
      if (targetClass) {
        return {
          classStatement: targetClass,
          filePath: targetFilePath
        };
      }
    }
  }

  const sourceRoots = options.sourceRoots ?? [];
  for (const filePath of scanMyFiles(sourceRoots)) {
    const targetSession = getSessionForFilePath(filePath, options);
    if (!targetSession?.ast) {
      continue;
    }
    const targetClass = findClassStatementInProgram(targetSession.ast, className);
    if (targetClass) {
      return {
        classStatement: targetClass,
        filePath
      };
    }
  }

  return null;
}

function typeNameFromAnalysisType(type: AnalysisType | undefined): string | null {
  if (!type) {
    return null;
  }
  if (type.kind === "builtin") {
    return type.name;
  }
  if (type.kind === "named") {
    return type.name;
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

export function resolveClassMember(
  classStatement: ClassStatement,
  memberName: string
): ResolvedClassMember | null {
  for (const parameter of classStatement.primaryConstructorParameters ?? []) {
    if (parameter.name.name !== memberName) {
      continue;
    }
    const typeName = parameter.typeAnnotation?.name ?? "unknown";
    const documentation = readDocumentationFromIdentifier(parameter.name);
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
        typeName: member.typeAnnotation?.name ?? "unknown"
      };
      if (documentation) {
        result.documentation = documentation;
      }
      return result;
    }

    const parameters: ResolvedParameter[] = member.parameters.map((parameter) => ({
      name: parameter.name.name,
      typeName: parameter.typeAnnotation?.name ?? "unknown",
      optional: parameter.optional === true || parameter.defaultValue !== undefined
    }));
    const returnTypeName = member.returnType?.name ?? "unknown";
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
      typeName: `(${parameters.map((parameter) => `${parameter.name}: ${parameter.typeName}`).join(", ")}) => ${returnTypeName}`,
      signature,
      ...(documentation ? { documentation } : {})
    };
  }

  return null;
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
      return (newExpression.callee as Identifier).name;
    }
    return null;
  }

  if (expression.kind === "CallExpression") {
    const call = expression as CallExpression;
    const callable = resolveCallableSignature(call.callee, analysis, ast, options);
    return callable?.returnTypeName ?? null;
  }

  if (expression.kind !== "MemberExpression") {
    return null;
  }

  const member = expression as MemberExpression;
  if (member.computed || member.property.kind !== "Identifier") {
    return null;
  }

  const objectTypeName = resolveExpressionTypeName(member.object, analysis, ast, options);
  if (!objectTypeName || BUILTIN_TYPE_NAMES.has(objectTypeName)) {
    return null;
  }

  const classResolution = resolveClassStatementAcrossFiles(ast, objectTypeName, options);
  if (!classResolution) {
    return null;
  }
  const memberResolution = resolveClassMember(
    classResolution.classStatement,
    (member.property as Identifier).name
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
          optional: parameter.optional === true
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
  if (!objectTypeName || BUILTIN_TYPE_NAMES.has(objectTypeName)) {
    return null;
  }

  const classResolution = resolveClassStatementAcrossFiles(ast, objectTypeName, options);
  if (!classResolution) {
    return null;
  }

  const memberResolution = resolveClassMember(
    classResolution.classStatement,
    (member.property as Identifier).name
  );
  if (!memberResolution || memberResolution.kind !== "method" || !memberResolution.signature) {
    return null;
  }

  return memberResolution.signature;
}
