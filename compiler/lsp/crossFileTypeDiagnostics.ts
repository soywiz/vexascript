import type {
  AssignmentExpression,
  CallExpression,
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
  return call.callee.kind === "MemberExpression" ? (call.callee as MemberExpression).property : call;
}

function constructorDiagnosticNode(node: CallExpression | NewExpression) {
  return node.callee.kind === "MemberExpression" ? (node.callee as MemberExpression).property : node.callee;
}

function collectCallExpressions(program: Program): CallExpression[] {
  const calls: CallExpression[] = [];
  walkAst(program, (node) => {
    if (node.kind === "CallExpression") {
      calls.push(node as CallExpression);
    }
  });
  return calls;
}

function collectAssignmentExpressions(program: Program): AssignmentExpression[] {
  const assignments: AssignmentExpression[] = [];
  walkAst(program, (node) => {
    if (node.kind === "AssignmentExpression") {
      assignments.push(node as AssignmentExpression);
    }
  });
  return assignments;
}

function collectImportStatements(program: Program): ImportStatement[] {
  return program.body.filter((statement): statement is ImportStatement => statement.kind === "ImportStatement");
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
    ...(params.getSessionForFilePath
      ? { getSessionForFilePath: params.getSessionForFilePath }
      : {})
  };
  const resolverCache = createClassResolverCache();
  const currentFilePath = uriToFilePath(params.uri);

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
        if (
          session.importedSymbolTypes.has(localName)
          || session.importedSymbolDisplayTypes.has(localName)
        ) {
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
      if (
        session.importedSymbolTypes.has(localName)
        || session.importedSymbolDisplayTypes.has(localName)
      ) {
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
    const targetSession = await getProjectSessionForFilePath(targetFilePath, options);
    if (!targetSession?.ast) {
      continue;
    }
    const exportedNames = new Set<string>();
    for (const statement of targetSession.ast.body) {
      for (const name of importableTopLevelDeclarationNames(statement, targetFilePath)) {
        exportedNames.add(name);
      }
    }
    for (const specifier of importStatement.specifiers) {
      const localName = (specifier.local ?? specifier.imported).name;
      if (
        session.importedSymbolTypes.has(localName)
        || session.importedSymbolDisplayTypes.has(localName)
      ) {
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
    const constructorSignature = await resolveConstructorSignature(
      call.callee,
      session.analysis,
      session.ast,
      options,
      call
    );
    if (constructorSignature) {
      const providedCount = call.arguments.length;
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
              call.arguments[index] ?? constructorDiagnosticNode(call),
              `Unexpected argument ${index + 1}; function expects at most ${totalCount} argument(s)`,
              VEXA_DIAGNOSTIC_CODES.CALL_UNEXPECTED_ARGUMENT
            )
          );
        }
      }
    }

    if (call.callee.kind !== "MemberExpression") {
      continue;
    }
    const callee = call.callee as MemberExpression;
    if (callee.computed || callee.property.kind !== "Identifier") {
      continue;
    }

    const objectType = session.analysis.getExpressionTypes().get(callee.object);
    if (
      objectType &&
      objectType.kind !== "array" &&
      objectType.kind !== "named" &&
      objectType.kind !== "builtin"
    ) {
      continue;
    }

    const objectTypeName = await resolveExpressionTypeName(callee.object, session.analysis, session.ast, options);
    if (!objectTypeName) {
      continue;
    }

    const classResolution = await resolveClassStatementAcrossFiles(
      session.ast,
      baseTypeName(objectTypeName),
      options,
      resolverCache
    );
    if (!classResolution) {
      continue;
    }
    if (isExternalDeclarationFilePath(classResolution.filePath)) {
      continue;
    }

    const memberName = (callee.property as Identifier).name;
    const member = await resolveClassMember(classResolution.classStatement, memberName, objectTypeName, {
      ast: session.ast,
      options,
      cache: resolverCache,
      analysis: session.analysis
    });
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
    const providedCount = call.arguments.length;
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
            call.arguments[index] ?? call,
            `Unexpected argument ${index + 1}; function expects at most ${totalCount} argument(s)`,
            VEXA_DIAGNOSTIC_CODES.CALL_UNEXPECTED_ARGUMENT
          )
        );
      }
    }

    const comparableCount = restParameter ? providedCount : Math.min(providedCount, totalCount);
    for (let index = 0; index < comparableCount; index += 1) {
      const parameter = fixedParameters[index] ?? restParameter;
      const argument = call.arguments[index];
      if (!parameter || !argument) {
        continue;
      }
      const argumentTypeName = await resolveExpressionTypeName(argument, session.analysis, session.ast, options);
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
    const constructorSignature = await resolveConstructorSignature(
      node.callee,
      session.analysis,
      session.ast,
      options,
      node
    );
    if (!constructorSignature) {
      continue;
    }

    const providedCount = node.arguments?.length ?? 0;
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
            node.arguments?.[index] ?? constructorDiagnosticNode(node),
            `Unexpected argument ${index + 1}; function expects at most ${totalCount} argument(s)`,
            VEXA_DIAGNOSTIC_CODES.CALL_UNEXPECTED_ARGUMENT
          )
        );
      }
    }
  }

  for (const assignment of collectAssignmentExpressions(session.ast)) {
    if (assignment.left.kind !== "MemberExpression") {
      continue;
    }
    const leftMember = assignment.left as MemberExpression;
    if (leftMember.computed || leftMember.property.kind !== "Identifier") {
      continue;
    }

    const objectType = session.analysis.getExpressionTypes().get(leftMember.object);
    if (
      objectType &&
      objectType.kind !== "array" &&
      objectType.kind !== "named" &&
      objectType.kind !== "builtin"
    ) {
      continue;
    }

    const objectTypeName = await resolveExpressionTypeName(leftMember.object, session.analysis, session.ast, options);
    if (!objectTypeName) {
      continue;
    }

    const classResolution = await resolveClassStatementAcrossFiles(
      session.ast,
      baseTypeName(objectTypeName),
      options,
      resolverCache
    );
    if (!classResolution) {
      continue;
    }
    if (isExternalDeclarationFilePath(classResolution.filePath)) {
      continue;
    }

    const memberName = (leftMember.property as Identifier).name;
    const member = await resolveClassMember(classResolution.classStatement, memberName, objectTypeName, {
      ast: session.ast,
      options,
      cache: resolverCache,
      analysis: session.analysis
    });
    if (!member) {
      continue;
    }

    const leftTypeName = member.kind === "method"
      ? (member.signature
        ? `(${member.signature.parameters.map((parameter) => `${parameter.name}: ${parameter.typeName}`).join(", ")}) => ${member.signature.returnTypeName}`
        : member.typeName)
      : member.typeName;
    const rightTypeName = await resolveExpressionTypeName(assignment.right, session.analysis, session.ast, options);
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
    if (node.kind === "NewExpression") {
      nodes.push(node as NewExpression);
    }
  });
  return nodes;
}
