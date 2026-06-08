import type { Analysis } from "compiler/analysis/Analysis";
import { baseTypeName } from "compiler/analysis/typeNames";
import { walkAst } from "compiler/ast/traversal";
import type {
  AssignmentExpression,
  ClassStatement,
  Identifier,
  MemberExpression,
  Program
} from "compiler/ast/ast";
import type { CodeAction, Diagnostic, Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "vscode-languageserver/node.js";
import {
  createClassResolverCache,
  resolveClassMember,
  resolveClassMemberDeclaration,
  resolveClassStatementAcrossFiles,
  resolveExpressionTypeName
} from "./classResolver";
import { pathToUri } from "./importFixes";
import { isTypeMismatchDiagnostic, TYPE_MISMATCH_PATTERN } from "./diagnosticCodes";
import { nodeRange, rangeContains, rangeSize } from "./ranges";

interface FindAssignmentResult {
  assignment: AssignmentExpression;
  range: Range;
  size: number;
}

function findAssignmentForDiagnosticRange(ast: Program, diagnosticRange: Range): AssignmentExpression | null {
  let best: FindAssignmentResult | null = null;

  walkAst(ast, (node) => {
    if (node.kind !== "AssignmentExpression") {
      return;
    }

    const assignment = node as AssignmentExpression;
    const rightRange = nodeRange(assignment.right);
    if (!rightRange || !rangeContains(diagnosticRange, rightRange)) {
      return;
    }
    const assignmentRange = nodeRange(assignment);
    if (!assignmentRange) {
      return;
    }
    const size = rangeSize(assignmentRange);
    if (!best || size <= best.size) {
      best = { assignment, range: assignmentRange, size };
    }
  });

  const resolvedBest = best as FindAssignmentResult | null;
  return resolvedBest?.assignment ?? null;
}

function buildMemberTypeEdit(
  classStatement: ClassStatement,
  memberName: string,
  typeName: string
): { range: Range; newText: string } | null {
  for (const parameter of classStatement.primaryConstructorParameters ?? []) {
    if (parameter.name.name !== memberName) {
      continue;
    }
    if (parameter.typeAnnotation) {
      const range = nodeRange(parameter.typeAnnotation);
      if (!range) {
        return null;
      }
      return { range, newText: typeName };
    }
    if (!parameter.name.lastToken) {
      return null;
    }
    return {
      range: {
        start: {
          line: parameter.name.lastToken.range.end.line,
          character: parameter.name.lastToken.range.end.column
        },
        end: {
          line: parameter.name.lastToken.range.end.line,
          character: parameter.name.lastToken.range.end.column
        }
      },
      newText: `: ${typeName}`
    };
  }

  for (const member of classStatement.members) {
    if (member.name.name !== memberName || member.kind !== "ClassFieldMember") {
      continue;
    }
    if (member.typeAnnotation) {
      const range = nodeRange(member.typeAnnotation);
      if (!range) {
        return null;
      }
      return { range, newText: typeName };
    }
    if (!member.name.lastToken) {
      return null;
    }
    return {
      range: {
        start: {
          line: member.name.lastToken.range.end.line,
          character: member.name.lastToken.range.end.column
        },
        end: {
          line: member.name.lastToken.range.end.line,
          character: member.name.lastToken.range.end.column
        }
      },
      newText: `: ${typeName}`
    };
  }

  return null;
}

export async function createTypeFixCodeActions(params: {
  uri: string;
  ast: Program | null;
  analysis: Analysis | null;
  diagnostics: Diagnostic[];
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => { ast: Program | null; analysis: Analysis | null } | null | Promise<{ ast: Program | null; analysis: Analysis | null } | null>;
  commandName?: string;
}): Promise<CodeAction[]> {
  if (!params.ast || !params.analysis) {
    return [];
  }

  const actions: CodeAction[] = [];
  const seen = new Set<string>();
  const resolverOptions = {
    uri: params.uri,
    sourceRoots: params.sourceRoots,
    ...(params.getSessionForFilePath
      ? { getSessionForFilePath: params.getSessionForFilePath }
      : {})
  };
  const resolverCache = createClassResolverCache();

  for (const diagnostic of params.diagnostics) {
    if (!isTypeMismatchDiagnostic(diagnostic)) {
      continue;
    }
    const mismatch = TYPE_MISMATCH_PATTERN.exec(diagnostic.message);
    if (!mismatch) {
      continue;
    }
    const sourceType = mismatch[1];
    if (!sourceType || sourceType === "unknown") {
      continue;
    }

    const assignment = findAssignmentForDiagnosticRange(params.ast, diagnostic.range);
    if (!assignment || assignment.left.kind !== "MemberExpression") {
      continue;
    }
    const leftMember = assignment.left as MemberExpression;
    if (leftMember.computed || leftMember.property.kind !== "Identifier") {
      continue;
    }

    const objectType = await resolveExpressionTypeName(
      leftMember.object,
      params.analysis,
      params.ast,
      resolverOptions
    );
    if (!objectType) {
      continue;
    }

    const classResolution = await resolveClassStatementAcrossFiles(
      params.ast,
      baseTypeName(objectType),
      resolverOptions,
      resolverCache
    );
    if (!classResolution) {
      continue;
    }

    const memberName = (leftMember.property as Identifier).name;
    const resolvedMember = await resolveClassMember(
      classResolution.classStatement,
      memberName,
      objectType,
      {
        ast: params.ast,
        options: resolverOptions,
        cache: resolverCache
      }
    );
    if (!resolvedMember || resolvedMember.kind !== "field") {
      continue;
    }

    const declaration = await resolveClassMemberDeclaration(
      classResolution,
      memberName,
      objectType,
      {
        ast: params.ast,
        options: resolverOptions,
        cache: resolverCache
      }
    );
    if (!declaration || declaration.kind !== "field") {
      continue;
    }

    const edit = buildMemberTypeEdit(declaration.classStatement, memberName, sourceType);
    if (!edit) {
      continue;
    }

    const targetUri = pathToUri(declaration.filePath);
    const key = `${targetUri}:${memberName}:${sourceType}:${edit.range.start.line}:${edit.range.start.character}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    actions.push({
      title: `Change type of '${declaration.classStatement.name.name}.${memberName}: ${resolvedMember.typeName}' to '${sourceType}'`,
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [targetUri]: [
            {
              range: edit.range,
              newText: edit.newText
            }
          ]
        }
      },
      ...(params.commandName
        ? {
            command: {
              title: "Refresh diagnostics",
              command: params.commandName
            }
          }
        : {})
    });
  }

  return actions;
}
