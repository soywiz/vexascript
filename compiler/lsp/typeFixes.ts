import { NodeKind } from "compiler/ast/ast";
import type { Analysis } from "compiler/analysis/Analysis";
import { baseTypeName } from "compiler/analysis/typeNames";
import { findBestMatch } from "./nodeSearch";
import type {
  AssignmentExpression,
  ClassStatement,
  Identifier,
  MemberExpression,
  Program
} from "compiler/ast/ast";
import type { CodeAction, Diagnostic, Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import {
  createClassResolverCache,
  resolveClassMember,
  resolveClassMemberDeclaration,
  resolveClassStatementAcrossFiles,
  resolveExpressionTypeName
} from "./classResolver";
import { pathToUri } from "./importFixes";
import { diagnosticHasCode, parseTypeMismatchDiagnostic, VEXA_DIAGNOSTIC_CODES } from "./diagnosticCodes";
import { findNodeContainingRange } from "./nodeSearch";
import { buildParameterTypeEdit } from "./parameterTypeEdits";
import { nodeRange, rangeContains, rangeSize } from "./ranges";
import type { FunctionParameter } from "compiler/ast/ast";

function findAssignmentForDiagnosticRange(ast: Program, diagnosticRange: Range): AssignmentExpression | null {
  return findBestMatch(ast, (node) => {
    if (node.kind !== NodeKind.AssignmentExpression) {
      return null;
    }

    const assignment = node as AssignmentExpression;
    const rightRange = nodeRange(assignment.right);
    if (!rightRange || !rangeContains(diagnosticRange, rightRange)) {
      return null;
    }
    const assignmentRange = nodeRange(assignment);
    if (!assignmentRange) {
      return null;
    }
    return { size: rangeSize(assignmentRange), value: assignment };
  });
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
    if (member.name.name !== memberName || member.kind !== NodeKind.ClassFieldMember) {
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

function findMissingTypeParameter(ast: Program, diagnosticRange: Range): FunctionParameter | null {
  return findNodeContainingRange(
    ast,
    diagnosticRange,
    (node): node is FunctionParameter =>
      node.kind === NodeKind.FunctionParameter &&
      (node as FunctionParameter).thisParameter !== true &&
      (node as FunctionParameter).name.kind === NodeKind.Identifier &&
      !(node as FunctionParameter).typeAnnotation
  );
}

export async function createTypeFixCodeActions(params: {
  uri: string;
  text: string;
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
    if (diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.MISSING_PARAMETER_TYPE)) {
      const parameter = findMissingTypeParameter(params.ast, diagnostic.range);
      if (!parameter) {
        continue;
      }
      const edit = buildParameterTypeEdit(parameter, params.text, "any");
      if (!edit) {
        continue;
      }
      const key = `${params.uri}:parameter-any:${edit.range.start.line}:${edit.range.start.character}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      actions.push({
        title: `Add explicit parameter type '${edit.newText}'`,
        kind: CodeActionKind.QuickFix,
        edit: {
          changes: {
            [params.uri]: [
              {
                range: edit.range,
                newText: edit.newText
              }
            ]
          }
        }
      });
      continue;
    }

    const mismatch = parseTypeMismatchDiagnostic(diagnostic);
    if (!mismatch || mismatch.sourceType === "unknown") {
      continue;
    }
    const sourceType = mismatch.sourceType;

    const assignment = findAssignmentForDiagnosticRange(params.ast, diagnostic.range);
    if (!assignment || assignment.left.kind !== NodeKind.MemberExpression) {
      continue;
    }
    const leftMember = assignment.left as MemberExpression;
    if (leftMember.computed || leftMember.property.kind !== NodeKind.Identifier) {
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
