import { AnalysisTypeKind } from "../analysis/types";
import { NodeKind } from "compiler/ast/ast";
import type {
  AssignmentExpression,
  CallExpression,
  Expr,
  ImportStatement,
  Identifier,
  MemberExpression,
  NewExpression,
  Program
} from "compiler/ast/ast";
import { baseTypeName } from "compiler/analysis/typeNames";
import { walkAst } from "compiler/ast/traversal";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "./diagnosticSeverity";
import type { AnalysisSession } from "./analysisSession";
import { VEXA_DIAGNOSTIC_CODES, type VexaScriptDiagnosticCode } from "./diagnosticCodes";
import {
  createClassResolverCache,
  resolveConstructorSignature,
  isTypeAssignableByName,
  resolveClassMember,
  resolveClassStatementAcrossFiles,
  resolveExpressionTypeName,
  type ClassResolverSessionLike
} from "./classResolver";
import { getProjectSessionForFilePath } from "./projectAnalysis";
import { importableTopLevelDeclarationNames } from "./declarationResolver";
import { resolveImportTargetFilePath, resolveNodeModulesTypingsPath } from "compiler/moduleResolution";
import { uriToFilePath } from "./importFixes";
import { ambientModuleHasNamedExport } from "./importedDeclarations";

export interface CollectCrossFileTypeDiagnosticsParams {
  uri: string;
  session: AnalysisSession;
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null | Promise<ClassResolverSessionLike | null>;
}

export interface CollectModuleNotFoundDiagnosticsParams {
  uri: string;
  session: AnalysisSession;
  getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null | Promise<ClassResolverSessionLike | null>;
}

function hasAmbientModuleForImportPath(
  ambientModuleDeclarations: ReadonlyMap<string, unknown>,
  importPath: string
): boolean {
  return ambientModuleDeclarations.has(importPath)
    || (importPath.startsWith("node:") && ambientModuleDeclarations.has(importPath.slice("node:".length)));
}

function isExternalDeclarationFilePath(filePath: string): boolean {
  return filePath.endsWith(".d.ts") || /(^|[/\\])node_modules([/\\]|$)/.test(filePath);
}

export async function collectModuleNotFoundDiagnostics(
  params: CollectModuleNotFoundDiagnosticsParams
): Promise<Diagnostic[]> {
  const { session } = params;
  if (!session.ast) {
    return [];
  }
  const currentFilePath = uriToFilePath(params.uri);
  if (!currentFilePath) {
    return [];
  }
  const diagnostics: Diagnostic[] = [];
  const resolutionOptions = params.getSessionForFilePath
    ? { getSessionForFilePath: params.getSessionForFilePath }
    : {};
  for (const importStatement of collectImportStatements(session.ast)) {
    const importPath = importStatement.from.value;
    const targetFilePath =
      await resolveImportTargetFilePath(currentFilePath, importPath, resolutionOptions)
      ?? await resolveNodeModulesTypingsPath(currentFilePath, importPath, resolutionOptions)
      ?? (hasAmbientModuleForImportPath(params.session.ambientModuleDeclarations, importPath) ? "ambient" : null);
    if (!targetFilePath) {
      const diagnostic = diagnosticForNode(
        importStatement.from,
        `Cannot find module '${importPath}'`,
        VEXA_DIAGNOSTIC_CODES.IMPORT_MODULE_NOT_FOUND
      );
      if (diagnostic) {
        diagnostics.push(diagnostic);
      }
    }
  }
  return diagnostics;
}

function diagnosticForNode(
  node: { firstToken?: { range: { start: { line: number; column: number } } }; lastToken?: { range: { end: { line: number; column: number } } } },
  message: string,
  code: VexaScriptDiagnosticCode
): Diagnostic | null {
  if (!node.firstToken || !node.lastToken) {
    return null;
  }
  return {
    code,
    severity: DiagnosticSeverity.Error,
    range: {
      start: {
        line: node.firstToken.range.start.line,
        character: node.firstToken.range.start.column
      },
      end: {
        line: node.lastToken.range.end.line,
        character: node.lastToken.range.end.column
      }
    },
    message,
    source: "vexa-sema"
  };
}

function callDiagnosticNode(call: CallExpression) {
  return call.callee.kind === NodeKind.MemberExpression ? (call.callee as MemberExpression).property : call;
}

function constructorDiagnosticNode(node: CallExpression | NewExpression) {
  return node.callee.kind === NodeKind.MemberExpression ? (node.callee as MemberExpression).property : node.callee;
}

function collectCallExpressions(program: Program): CallExpression[] {
  const calls: CallExpression[] = [];
  walkAst(program, (node) => {
    if (node.kind === NodeKind.CallExpression) {
      calls.push(node as CallExpression);
    }
  });
  return calls;
}

function collectAssignmentExpressions(program: Program): AssignmentExpression[] {
  const assignments: AssignmentExpression[] = [];
  walkAst(program, (node) => {
    if (node.kind === NodeKind.AssignmentExpression) {
      assignments.push(node as AssignmentExpression);
    }
  });
  return assignments;
}

function collectImportStatements(program: Program): ImportStatement[] {
  return program.body.filter((statement): statement is ImportStatement => statement.kind === NodeKind.ImportStatement);
}

export async function collectCrossFileTypeDiagnostics(
  params: CollectCrossFileTypeDiagnosticsParams
): Promise<Diagnostic[]> {
  const { session } = params;
  if (!session.ast || !session.analysis) {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const existing = new Set(
    session.semanticIssues.map((issue) => {
      const token = issue.node.firstToken;
      if (!token) {
        return issue.message;
      }
      return `${token.range.start.line}:${token.range.start.column}:${issue.message}`;
    })
  );
  const options = {
    uri: params.uri,
    sourceRoots: params.sourceRoots,
    classResolverCache: createClassResolverCache(),
    ...(params.getSessionForFilePath
      ? { getSessionForFilePath: params.getSessionForFilePath }
      : {})
  };
  const resolverCache = options.classResolverCache;
  const currentFilePath = uriToFilePath(params.uri);
  const expressionTypeNameCache = new WeakMap<Expr, Promise<string | null>>();
  const constructorSignatureCache = new WeakMap<Expr, Promise<Awaited<ReturnType<typeof resolveConstructorSignature>>>>();
  const exportedNamesByTargetFilePath = new Map<string, Promise<Set<string>>>();
  const classResolutionByTypeName = new Map<string, Promise<Awaited<ReturnType<typeof resolveClassStatementAcrossFiles>>>>();
  const classMemberByKey = new Map<string, Promise<Awaited<ReturnType<typeof resolveClassMember>>>>();

  const resolveExpressionTypeNameCached = (expression: Expr): Promise<string | null> => {
    const cached = expressionTypeNameCache.get(expression);
    if (cached) {
      return cached;
    }
    const pending = resolveExpressionTypeName(expression, session.analysis!, session.ast!, options);
    expressionTypeNameCache.set(expression, pending);
    return pending;
  };

  const resolveConstructorSignatureCached = (
    callee: Expr,
    callNode: CallExpression | NewExpression
  ): Promise<Awaited<ReturnType<typeof resolveConstructorSignature>>> => {
    const cached = constructorSignatureCache.get(callNode);
    if (cached) {
      return cached;
    }
    const pending = resolveConstructorSignature(
      callee,
      session.analysis!,
      session.ast!,
      options,
      callNode
    );
    constructorSignatureCache.set(callNode, pending);
    return pending;
  };

  const exportedNamesForTarget = async (
    targetFilePath: string
  ): Promise<Set<string>> => {
    const cached = exportedNamesByTargetFilePath.get(targetFilePath);
    if (cached) {
      return cached;
    }
    const pending = (async () => {
      const targetSession = await getProjectSessionForFilePath(targetFilePath, options);
      const exportedNames = new Set<string>();
      for (const statement of targetSession?.ast?.body ?? []) {
        for (const name of importableTopLevelDeclarationNames(statement, targetFilePath)) {
          exportedNames.add(name);
        }
      }
      return exportedNames;
    })();
    exportedNamesByTargetFilePath.set(targetFilePath, pending);
    return pending;
  };

  const resolveClassStatementAcrossFilesCached = (
    typeName: string
  ): Promise<Awaited<ReturnType<typeof resolveClassStatementAcrossFiles>>> => {
    const cacheKey = baseTypeName(typeName);
    const cached = classResolutionByTypeName.get(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = resolveClassStatementAcrossFiles(
      session.ast!,
      cacheKey,
      options,
      resolverCache
    );
    classResolutionByTypeName.set(cacheKey, pending);
    return pending;
  };

  const resolveClassMemberCached = (
    className: string,
    memberName: string,
    objectTypeName: string,
    classStatement: NonNullable<Awaited<ReturnType<typeof resolveClassStatementAcrossFiles>>>["classStatement"]
  ): Promise<Awaited<ReturnType<typeof resolveClassMember>>> => {
    const cacheKey = `${className}\0${memberName}\0${objectTypeName}`;
    const cached = classMemberByKey.get(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = resolveClassMember(classStatement, memberName, objectTypeName, {
      ast: session.ast!,
      options,
      cache: resolverCache,
      analysis: session.analysis!
    });
    classMemberByKey.set(cacheKey, pending);
    return pending;
  };

  const pushDiagnostic = (diagnostic: Diagnostic | null): void => {
    if (!diagnostic) {
      return;
    }
    const existingKey = `${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}`;
    if (existing.has(existingKey)) {
      return;
    }
    const key = `${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.range.end.line}:${diagnostic.range.end.character}:${diagnostic.message}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  const hasResolvedImportedBinding = (localName: string): boolean => {
    const resolution = session.importedSymbols?.get(localName);
    return !!resolution && !!(resolution.type || resolution.displayType);
  };

  for (const importStatement of collectImportStatements(session.ast)) {
    if (!currentFilePath) {
      continue;
    }
    const importPath = importStatement.from.value;
    const resOptions = {
      ...(params.getSessionForFilePath ? { getSessionForFilePath: params.getSessionForFilePath } : {}),
    };
    const targetFilePath = await resolveImportTargetFilePath(currentFilePath, importPath, resOptions);
    if (!targetFilePath) {
      if (!session.ambientModuleDeclarations || importStatement.specifiers.length === 0) {
        continue;
      }
      for (const specifier of importStatement.specifiers) {
        const localName = (specifier.local ?? specifier.imported).name;
        if (hasResolvedImportedBinding(localName)) {
          continue;
        }
        if (session.invalidImportedBindings.has(localName)) {
          pushDiagnostic(
            diagnosticForNode(
              specifier.imported,
              `Module '${importPath}' has no exported symbol '${specifier.imported.name}'`,
              VEXA_DIAGNOSTIC_CODES.IMPORT_MISSING_EXPORT
            )
          );
          continue;
        }
        if (ambientModuleHasNamedExport(importPath, specifier.imported.name, session.ambientModuleDeclarations)) {
          continue;
        }
        pushDiagnostic(
          diagnosticForNode(
            specifier.imported,
            `Module '${importPath}' has no exported symbol '${specifier.imported.name}'`,
            VEXA_DIAGNOSTIC_CODES.IMPORT_MISSING_EXPORT
          )
        );
      }
      continue;
    }
    if (importStatement.specifiers.length === 0) {
      continue;
    }
    for (const specifier of importStatement.specifiers) {
      const localName = (specifier.local ?? specifier.imported).name;
      if (hasResolvedImportedBinding(localName)) {
        continue;
      }
      if (session.invalidImportedBindings.has(localName)) {
        pushDiagnostic(
          diagnosticForNode(
            specifier.imported,
            `Module '${importPath}' has no exported symbol '${specifier.imported.name}'`,
            VEXA_DIAGNOSTIC_CODES.IMPORT_MISSING_EXPORT
          )
        );
      }
    }
    const exportedNames = await exportedNamesForTarget(targetFilePath);
    for (const specifier of importStatement.specifiers) {
      const localName = (specifier.local ?? specifier.imported).name;
      if (hasResolvedImportedBinding(localName)) {
        continue;
      }
      if (exportedNames.has(specifier.imported.name)) {
        continue;
      }
      pushDiagnostic(
        diagnosticForNode(
          specifier.imported,
          `Module '${importPath}' has no exported symbol '${specifier.imported.name}'`,
          VEXA_DIAGNOSTIC_CODES.IMPORT_MISSING_EXPORT
        )
      );
    }
  }

  for (const call of collectCallExpressions(session.ast)) {
    const constructorSignature = await resolveConstructorSignatureCached(call.callee, call);
    if (constructorSignature) {
      const providedCount = call.args.length;
      const requiredCount = constructorSignature.parameters.filter((parameter) => !parameter.optional).length;
      const totalCount = constructorSignature.parameters.length;

      if (providedCount < requiredCount) {
        pushDiagnostic(
          diagnosticForNode(
            constructorDiagnosticNode(call),
            `Expected at least ${requiredCount} argument(s), but got ${providedCount}`,
            VEXA_DIAGNOSTIC_CODES.CALL_TOO_FEW_ARGUMENTS
          )
        );
      } else if (providedCount > totalCount) {
        pushDiagnostic(
          diagnosticForNode(
            constructorDiagnosticNode(call),
            `Expected at most ${totalCount} argument(s), but got ${providedCount}`,
            VEXA_DIAGNOSTIC_CODES.CALL_TOO_MANY_ARGUMENTS
          )
        );
        for (let index = totalCount; index < providedCount; index += 1) {
          pushDiagnostic(
            diagnosticForNode(
              call.args[index] ?? constructorDiagnosticNode(call),
              `Unexpected argument ${index + 1}; function expects at most ${totalCount} argument(s)`,
              VEXA_DIAGNOSTIC_CODES.CALL_UNEXPECTED_ARGUMENT
            )
          );
        }
      }
    }

    if (call.callee.kind !== NodeKind.MemberExpression) {
      continue;
    }
    const callee = call.callee as MemberExpression;
    if (callee.computed || callee.property.kind !== NodeKind.Identifier) {
      continue;
    }

    const objectType = session.analysis.getExpressionTypes().get(callee.object);
    if (
      objectType &&
      objectType.kind !== AnalysisTypeKind.Array &&
      objectType.kind !== AnalysisTypeKind.Named &&
      objectType.kind !== AnalysisTypeKind.Builtin
    ) {
      continue;
    }

    const objectTypeName = await resolveExpressionTypeNameCached(callee.object);
    if (!objectTypeName) {
      continue;
    }

    const classResolution = await resolveClassStatementAcrossFilesCached(objectTypeName);
    if (!classResolution) {
      continue;
    }
    if (isExternalDeclarationFilePath(classResolution.filePath)) {
      continue;
    }

    const memberName = (callee.property as Identifier).name;
    const member = await resolveClassMemberCached(
      classResolution.classStatement.name.name,
      memberName,
      objectTypeName,
      classResolution.classStatement
    );
    if (!member) {
      continue;
    }

    if (member.kind !== "method" || !member.signature) {
      pushDiagnostic(
        diagnosticForNode(
          callee.property,
          `Property '${memberName}' of type '${objectTypeName}' is not callable`,
          VEXA_DIAGNOSTIC_CODES.TYPE_MISMATCH
        )
      );
      continue;
    }

    const signature = member.signature;
    const providedCount = call.args.length;
    const lastParameter = signature.parameters[signature.parameters.length - 1];
    const restParameter = lastParameter?.rest ? lastParameter : undefined;
    const fixedParameters = restParameter ? signature.parameters.slice(0, -1) : signature.parameters;
    const requiredCount = fixedParameters.filter((parameter) => !parameter.optional).length;
    const totalCount = fixedParameters.length;

    if (providedCount < requiredCount) {
      pushDiagnostic(
        diagnosticForNode(
          callDiagnosticNode(call),
          `Expected at least ${requiredCount} argument(s), but got ${providedCount}`,
          VEXA_DIAGNOSTIC_CODES.CALL_TOO_FEW_ARGUMENTS
        )
      );
    } else if (!restParameter && providedCount > totalCount) {
      pushDiagnostic(
        diagnosticForNode(
          callDiagnosticNode(call),
          `Expected at most ${totalCount} argument(s), but got ${providedCount}`,
          VEXA_DIAGNOSTIC_CODES.CALL_TOO_MANY_ARGUMENTS
        )
      );
      for (let index = totalCount; index < providedCount; index += 1) {
        pushDiagnostic(
          diagnosticForNode(
            call.args[index] ?? call,
            `Unexpected argument ${index + 1}; function expects at most ${totalCount} argument(s)`,
            VEXA_DIAGNOSTIC_CODES.CALL_UNEXPECTED_ARGUMENT
          )
        );
      }
    }

    const comparableCount = restParameter ? providedCount : Math.min(providedCount, totalCount);
    for (let index = 0; index < comparableCount; index += 1) {
      const parameter = fixedParameters[index] ?? restParameter;
      const argument = call.args[index];
      if (!parameter || !argument) {
        continue;
      }
      const argumentTypeName = await resolveExpressionTypeNameCached(argument);
      if (!argumentTypeName || argumentTypeName === "unknown") {
        continue;
      }
      if (isTypeAssignableByName(argumentTypeName, parameter.typeName)) {
        continue;
      }
      pushDiagnostic(
        diagnosticForNode(
          argument,
          `Argument ${index + 1} of type '${argumentTypeName}' is not assignable to parameter '${parameter.name}' of type '${parameter.typeName}'`,
          VEXA_DIAGNOSTIC_CODES.CALL_ARGUMENT_TYPE_MISMATCH
        )
      );
    }
  }

  for (const node of walkCallLikeNewExpressions(session.ast)) {
    const constructorSignature = await resolveConstructorSignatureCached(node.callee, node);
    if (!constructorSignature) {
      continue;
    }

    const providedCount = node.args?.length ?? 0;
    const requiredCount = constructorSignature.parameters.filter((parameter) => !parameter.optional).length;
    const totalCount = constructorSignature.parameters.length;

    if (providedCount < requiredCount) {
      pushDiagnostic(
        diagnosticForNode(
          constructorDiagnosticNode(node),
          `Expected at least ${requiredCount} argument(s), but got ${providedCount}`,
          VEXA_DIAGNOSTIC_CODES.CALL_TOO_FEW_ARGUMENTS
        )
      );
    } else if (providedCount > totalCount) {
      pushDiagnostic(
        diagnosticForNode(
          constructorDiagnosticNode(node),
          `Expected at most ${totalCount} argument(s), but got ${providedCount}`,
          VEXA_DIAGNOSTIC_CODES.CALL_TOO_MANY_ARGUMENTS
        )
      );
      for (let index = totalCount; index < providedCount; index += 1) {
        pushDiagnostic(
          diagnosticForNode(
            node.args?.[index] ?? constructorDiagnosticNode(node),
            `Unexpected argument ${index + 1}; function expects at most ${totalCount} argument(s)`,
            VEXA_DIAGNOSTIC_CODES.CALL_UNEXPECTED_ARGUMENT
          )
        );
      }
    }
  }

  for (const assignment of collectAssignmentExpressions(session.ast)) {
    if (assignment.left.kind !== NodeKind.MemberExpression) {
      continue;
    }
    const leftMember = assignment.left as MemberExpression;
    if (leftMember.computed || leftMember.property.kind !== NodeKind.Identifier) {
      continue;
    }

    const objectType = session.analysis.getExpressionTypes().get(leftMember.object);
    if (
      objectType &&
      objectType.kind !== AnalysisTypeKind.Array &&
      objectType.kind !== AnalysisTypeKind.Named &&
      objectType.kind !== AnalysisTypeKind.Builtin
    ) {
      continue;
    }

    const objectTypeName = await resolveExpressionTypeNameCached(leftMember.object);
    if (!objectTypeName) {
      continue;
    }

    const classResolution = await resolveClassStatementAcrossFilesCached(objectTypeName);
    if (!classResolution) {
      continue;
    }
    if (isExternalDeclarationFilePath(classResolution.filePath)) {
      continue;
    }

    const memberName = (leftMember.property as Identifier).name;
    const member = await resolveClassMemberCached(
      classResolution.classStatement.name.name,
      memberName,
      objectTypeName,
      classResolution.classStatement
    );
    if (!member) {
      continue;
    }

    const leftTypeName = member.kind === "method"
      ? (member.signature
        ? `(${member.signature.parameters.map((parameter) => `${parameter.name}: ${parameter.typeName}`).join(", ")}) => ${member.signature.returnTypeName}`
        : member.typeName)
      : member.typeName;
    const rightTypeName = await resolveExpressionTypeNameCached(assignment.right);
    if (!rightTypeName || rightTypeName === "unknown" || leftTypeName === "unknown") {
      continue;
    }
    if (isTypeAssignableByName(rightTypeName, leftTypeName)) {
      continue;
    }

    pushDiagnostic(
      diagnosticForNode(
        assignment.right,
        `Type '${rightTypeName}' is not assignable to type '${leftTypeName}'`,
        VEXA_DIAGNOSTIC_CODES.TYPE_MISMATCH
      )
    );
  }

  return diagnostics;
}

function walkCallLikeNewExpressions(program: Program): NewExpression[] {
  const nodes: NewExpression[] = [];
  walkAst(program, (node) => {
    if (node.kind === NodeKind.NewExpression) {
      nodes.push(node as NewExpression);
    }
  });
  return nodes;
}
