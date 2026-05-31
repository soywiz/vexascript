import { existsSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type { Analysis } from "compiler/analysis/Analysis";
import { type AnalysisType, typeToString } from "compiler/analysis/types";
import type {
  AssignmentExpression,
  BinaryExpression,
  CallExpression,
  ClassStatement,
  ConditionalExpression,
  Expr,
  Identifier,
  ImportStatement,
  MemberExpression,
  NewExpression,
  UnaryExpression,
  UpdateExpression,
  Program
} from "compiler/ast/ast";
import { uriToFilePath } from "./importFixes";
import {
  getProjectSessionForFilePath,
  scanProjectMyFiles,
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

export interface ResolvedConstructorSignature {
  className: string;
  parameters: ResolvedParameter[];
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

function getSessionForFilePath(
  filePath: string,
  options: ClassResolverOptions
): ClassResolverSessionLike | null {
  return getProjectSessionForFilePath(filePath, options);
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
  for (const filePath of scanProjectMyFiles(sourceRoots)) {
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

  const symbol = analysis.getSymbolAt(
    identifier.firstToken.range.start.line,
    identifier.firstToken.range.start.column
  )?.symbol;
  if (!symbol || symbol.kind !== "class") {
    return null;
  }

  const classResolution = resolveClassStatementAcrossFiles(ast, symbol.name, options);
  if (!classResolution) {
    return null;
  }

  return {
    className: symbol.name,
    parameters: (classResolution.classStatement.primaryConstructorParameters ?? []).map((parameter) => ({
      name: parameter.name.name,
      typeName: parameter.typeAnnotation?.name ?? "unknown",
      optional: false
    }))
  };
}
