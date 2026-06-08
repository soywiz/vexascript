import { baseTypeName } from "compiler/analysis/typeNames";
import { walkAst } from "compiler/ast/traversal";
import type {
  AssignmentExpression,
  CallExpression,
  ClassStatement,
  Identifier,
  MemberExpression,
  Program
} from "compiler/ast/ast";
import type { Analysis } from "compiler/analysis/Analysis";
import { type AnalysisType, typeToString } from "compiler/analysis/types";
import type { CodeAction, Diagnostic, Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "vscode-languageserver/node.js";
import { pathToUri } from "./importFixes";
import {
  createClassResolverCache,
  resolveClassMember,
  resolveClassStatementAcrossFiles,
  type ClassResolverCache,
  type ClassResolverSessionLike
} from "./classResolver";
import {
  isMissingMemberDiagnostic,
  MISSING_MEMBER_PATTERN
} from "./diagnosticCodes";
import { nodeRange, rangeContains } from "./ranges";

interface ClassResolution {
  classStatement: ClassStatement;
  filePath: string;
  objectTypeName: string;
  cache: ClassResolverCache;
  options: {
    uri: string;
    sourceRoots: string[];
    getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null | Promise<ClassResolverSessionLike | null>;
  };
}

interface MissingMemberDiagnosticMatch {
  memberName: string;
  typeName: string;
  className: string;
}

function parseMissingMemberDiagnostic(diagnostic: Diagnostic): MissingMemberDiagnosticMatch | null {
  if (!isMissingMemberDiagnostic(diagnostic)) {
    return null;
  }
  const match = MISSING_MEMBER_PATTERN.exec(diagnostic.message);
  if (!match) {
    return null;
  }
  const memberName = match[1];
  const typeName = match[2];
  if (!memberName || !typeName) {
    return null;
  }
  return { memberName, typeName, className: baseTypeName(typeName) };
}

async function resolveClassTarget(params: {
  currentUri: string;
  currentAst: Program;
  typeName: string;
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null | Promise<ClassResolverSessionLike | null>;
}): Promise<ClassResolution | null> {
  const cache = createClassResolverCache();
  const options = {
    uri: params.currentUri,
    sourceRoots: params.sourceRoots,
    ...(params.getSessionForFilePath
      ? { getSessionForFilePath: params.getSessionForFilePath }
      : {})
  };
  const classResolution = await resolveClassStatementAcrossFiles(
    params.currentAst,
    baseTypeName(params.typeName),
    options,
    cache
  );
  if (!classResolution) {
    return null;
  }
  return {
    classStatement: classResolution.classStatement,
    filePath: classResolution.filePath,
    objectTypeName: params.typeName,
    cache,
    options
  };
}

function insertRangeAtClassEnd(classStatement: ClassStatement): Range | null {
  const last = classStatement.lastToken;
  if (!last) {
    return null;
  }

  if (last.type === "symbol" && last.value === "}") {
    return {
      start: {
        line: last.range.start.line,
        character: last.range.start.column
      },
      end: {
        line: last.range.start.line,
        character: last.range.start.column
      }
    };
  }

  return {
    start: {
      line: last.range.end.line,
      character: last.range.end.column
    },
    end: {
      line: last.range.end.line,
      character: last.range.end.column
    }
  };
}

function newMemberText(classStatement: ClassStatement, memberName: string): string {
  const last = classStatement.lastToken;
  if (last?.type === "symbol" && last.value === "}") {
    if (classStatement.members.length === 0) {
      return `\n  ${memberName}: unknown\n`;
    }
    return `\n  ${memberName}: unknown`;
  }
  return ` {\n  ${memberName}: unknown\n}`;
}

function isTypeNameUsable(typeName: string | null | undefined): typeName is string {
  if (!typeName) {
    return false;
  }
  return typeName !== "unknown";
}

function normalizeInferredType(type: AnalysisType | undefined): string | null {
  if (!type) {
    return null;
  }
  const typeName = typeToString(type);
  if (!isTypeNameUsable(typeName)) {
    return null;
  }
  return typeName;
}

function inferMissingMemberTypeFromDiagnostic(
  ast: Program,
  analysis: Analysis | null,
  diagnostic: Diagnostic,
  memberName: string
): string | null {
  if (!analysis) {
    return null;
  }
  const expressionTypes = analysis.getExpressionTypes();
  let inferred: string | null = null;

  const matchingProperty = (property: Identifier): boolean => {
    const propertyRange = nodeRange(property);
    return property.name === memberName &&
      !!propertyRange &&
      rangeContains(diagnostic.range, propertyRange);
  };

  walkAst(ast, (node) => {
    if (node.kind === "AssignmentExpression") {
      const assignment = node as AssignmentExpression;
      if (
        assignment.left.kind === "MemberExpression" &&
        (assignment.left as MemberExpression).property.kind === "Identifier"
      ) {
        const leftMember = assignment.left as MemberExpression;
        const property = leftMember.property as Identifier;
        if (matchingProperty(property)) {
          inferred = normalizeInferredType(expressionTypes.get(assignment.right));
        }
      }
      return;
    }

    if (node.kind === "CallExpression") {
      const call = node as CallExpression;
      if (
        call.callee.kind === "MemberExpression" &&
        (call.callee as MemberExpression).property.kind === "Identifier"
      ) {
        const calleeMember = call.callee as MemberExpression;
        const property = calleeMember.property as Identifier;
        if (matchingProperty(property)) {
          const parameters = call.arguments.map((argument, index) => {
            const argType = normalizeInferredType(expressionTypes.get(argument)) ?? "unknown";
            return `arg${index + 1}: ${argType}`;
          });
          inferred = `(${parameters.join(", ")}) => unknown`;
        }
      }
    }
  });

  return inferred;
}

export async function createCreateMemberCodeActions(params: {
  uri: string;
  ast: Program | null;
  analysis?: Analysis | null;
  diagnostics: Diagnostic[];
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null | Promise<ClassResolverSessionLike | null>;
}): Promise<CodeAction[]> {
  const { uri, ast, diagnostics, sourceRoots } = params;
  if (!ast || diagnostics.length === 0) {
    return [];
  }

  const actions: CodeAction[] = [];
  const seen = new Set<string>();

  for (const diagnostic of diagnostics) {
    const parsed = parseMissingMemberDiagnostic(diagnostic);
    if (!parsed) {
      continue;
    }
    const { className, memberName, typeName } = parsed;

    const classTarget = await resolveClassTarget({
      currentUri: uri,
      currentAst: ast,
      typeName,
      sourceRoots,
      ...(params.getSessionForFilePath
        ? { getSessionForFilePath: params.getSessionForFilePath }
        : {})
    });
    if (!classTarget) {
      continue;
    }
    const existingMember = await resolveClassMember(
      classTarget.classStatement,
      memberName,
      classTarget.objectTypeName,
      {
        ast,
        options: classTarget.options,
        cache: classTarget.cache
      }
    );
    if (existingMember) {
      continue;
    }

    const range = insertRangeAtClassEnd(classTarget.classStatement);
    if (!range) {
      continue;
    }
    const inferredType = inferMissingMemberTypeFromDiagnostic(
      ast,
      params.analysis ?? null,
      diagnostic,
      memberName
    );
    const memberText = newMemberText(
      classTarget.classStatement,
      memberName
    ).replace(": unknown", `: ${inferredType ?? "unknown"}`);
    const targetUri = pathToUri(classTarget.filePath);
    const key = `${targetUri}:${className}:${memberName}:${range.start.line}:${range.start.character}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    actions.push({
      title: `Create member '${memberName}' in class '${className}'`,
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [targetUri]: [
            {
              range,
              newText: memberText
            }
          ]
        }
      }
    });
  }

  return actions;
}
