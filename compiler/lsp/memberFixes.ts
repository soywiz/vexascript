import { baseTypeName } from "compiler/analysis/typeNames";
import type {
  ClassStatement,
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

interface ClassResolution {
  classStatement: ClassStatement;
  filePath: string;
  objectTypeName: string;
  cache: ClassResolverCache;
  options: {
    uri: string;
    sourceRoots: string[];
    getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null;
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

function resolveClassTarget(params: {
  currentUri: string;
  currentAst: Program;
  typeName: string;
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null;
}): ClassResolution | null {
  const cache = createClassResolverCache();
  const options = {
    uri: params.currentUri,
    sourceRoots: params.sourceRoots,
    ...(params.getSessionForFilePath
      ? { getSessionForFilePath: params.getSessionForFilePath }
      : {})
  };
  const classResolution = resolveClassStatementAcrossFiles(
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

function rangeContains(range: Range, candidate: Range): boolean {
  const startsBefore =
    range.start.line < candidate.start.line ||
    (range.start.line === candidate.start.line &&
      range.start.character <= candidate.start.character);
  const endsAfter =
    range.end.line > candidate.end.line ||
    (range.end.line === candidate.end.line &&
      range.end.character >= candidate.end.character);
  return startsBefore && endsAfter;
}

function nodeRange(node: { firstToken?: { range: { start: { line: number; column: number } } }; lastToken?: { range: { end: { line: number; column: number } } } }): Range | null {
  if (!node.firstToken || !node.lastToken) {
    return null;
  }
  return {
    start: {
      line: node.firstToken.range.start.line,
      character: node.firstToken.range.start.column
    },
    end: {
      line: node.lastToken.range.end.line,
      character: node.lastToken.range.end.column
    }
  };
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

  const visitExpression = (expression: import("compiler/ast/ast").Expr): void => {
    switch (expression.kind) {
      case "AssignmentExpression": {
        const assignment = expression as import("compiler/ast/ast").AssignmentExpression;
        if (
          assignment.left.kind === "MemberExpression" &&
          (assignment.left as import("compiler/ast/ast").MemberExpression).property.kind === "Identifier"
        ) {
          const leftMember = assignment.left as import("compiler/ast/ast").MemberExpression;
          const property = leftMember.property as import("compiler/ast/ast").Identifier;
          const propertyRange = nodeRange(property);
          if (
            property.name === memberName &&
            propertyRange &&
            rangeContains(diagnostic.range, propertyRange)
          ) {
            inferred = normalizeInferredType(expressionTypes.get(assignment.right));
          }
        }
        visitExpression(assignment.left);
        visitExpression(assignment.right);
        return;
      }
      case "CallExpression": {
        const call = expression as import("compiler/ast/ast").CallExpression;
        if (
          call.callee.kind === "MemberExpression" &&
          (call.callee as import("compiler/ast/ast").MemberExpression).property.kind === "Identifier"
        ) {
          const calleeMember = call.callee as import("compiler/ast/ast").MemberExpression;
          const property = calleeMember.property as import("compiler/ast/ast").Identifier;
          const propertyRange = nodeRange(property);
          if (
            property.name === memberName &&
            propertyRange &&
            rangeContains(diagnostic.range, propertyRange)
          ) {
            const parameters = call.arguments.map((argument, index) => {
              const argType = normalizeInferredType(expressionTypes.get(argument)) ?? "unknown";
              return `arg${index + 1}: ${argType}`;
            });
            inferred = `(${parameters.join(", ")}) => unknown`;
          }
        }
        visitExpression(call.callee);
        for (const argument of call.arguments) {
          visitExpression(argument);
        }
        return;
      }
      case "MemberExpression":
        visitExpression((expression as import("compiler/ast/ast").MemberExpression).object);
        if ((expression as import("compiler/ast/ast").MemberExpression).computed) {
          visitExpression((expression as import("compiler/ast/ast").MemberExpression).property);
        }
        return;
      case "NewExpression":
        visitExpression((expression as import("compiler/ast/ast").NewExpression).callee);
        for (const argument of (expression as import("compiler/ast/ast").NewExpression).arguments ?? []) {
          visitExpression(argument);
        }
        return;
      case "BinaryExpression":
        visitExpression((expression as import("compiler/ast/ast").BinaryExpression).left);
        visitExpression((expression as import("compiler/ast/ast").BinaryExpression).right);
        return;
      case "RangeExpression":
        visitExpression((expression as import("compiler/ast/ast").RangeExpression).start);
        visitExpression((expression as import("compiler/ast/ast").RangeExpression).end);
        return;
      case "ConditionalExpression":
        visitExpression((expression as import("compiler/ast/ast").ConditionalExpression).test);
        visitExpression((expression as import("compiler/ast/ast").ConditionalExpression).consequent);
        visitExpression((expression as import("compiler/ast/ast").ConditionalExpression).alternate);
        return;
      case "UnaryExpression":
      case "UpdateExpression":
        visitExpression((expression as import("compiler/ast/ast").UnaryExpression | import("compiler/ast/ast").UpdateExpression).argument);
        return;
      case "ArrayLiteral":
        for (const element of (expression as import("compiler/ast/ast").ArrayLiteral).elements) {
          visitExpression(element);
        }
        return;
      case "ObjectLiteral":
        for (const property of (expression as import("compiler/ast/ast").ObjectLiteral).properties) {
          if (property.kind === "ObjectSpreadProperty") {
            visitExpression(property.argument);
          } else {
            visitExpression(property.value);
          }
        }
        return;
      default:
        return;
    }
  };

  const visitStatement = (statement: import("compiler/ast/ast").Statement): void => {
    switch (statement.kind) {
      case "VarStatement":
        if ((statement as import("compiler/ast/ast").VarStatement).declarations?.length) {
          for (const declaration of (statement as import("compiler/ast/ast").VarStatement).declarations ?? []) {
            if (declaration.initializer) {
              visitExpression(declaration.initializer);
            }
          }
        } else if ((statement as import("compiler/ast/ast").VarStatement).initializer) {
          visitExpression((statement as import("compiler/ast/ast").VarStatement).initializer!);
        }
        return;
      case "ExprStatement":
        visitExpression((statement as import("compiler/ast/ast").ExprStatement).expression);
        return;
      case "ReturnStatement":
        if ((statement as import("compiler/ast/ast").ReturnStatement).expression) {
          visitExpression((statement as import("compiler/ast/ast").ReturnStatement).expression!);
        }
        return;
      case "ThrowStatement":
        visitExpression((statement as import("compiler/ast/ast").ThrowStatement).expression);
        return;
      case "BlockStatement":
        for (const child of (statement as import("compiler/ast/ast").BlockStatement).body) {
          visitStatement(child);
        }
        return;
      case "FunctionStatement":
        for (const child of (statement as import("compiler/ast/ast").FunctionStatement).body.body) {
          visitStatement(child);
        }
        return;
      case "ClassStatement":
        for (const member of (statement as import("compiler/ast/ast").ClassStatement).members) {
          if (member.kind === "ClassFieldMember" && member.initializer) {
            visitExpression(member.initializer);
          } else if (member.kind === "ClassMethodMember") {
            for (const child of member.body.body) {
              visitStatement(child);
            }
          }
        }
        return;
      case "IfStatement":
        visitExpression((statement as import("compiler/ast/ast").IfStatement).condition);
        visitStatement((statement as import("compiler/ast/ast").IfStatement).thenBranch);
        if ((statement as import("compiler/ast/ast").IfStatement).elseBranch) {
          visitStatement((statement as import("compiler/ast/ast").IfStatement).elseBranch!);
        }
        return;
      case "WhileStatement":
        visitExpression((statement as import("compiler/ast/ast").WhileStatement).condition);
        visitStatement((statement as import("compiler/ast/ast").WhileStatement).body);
        return;
      case "DoWhileStatement":
        visitStatement((statement as import("compiler/ast/ast").DoWhileStatement).body);
        visitExpression((statement as import("compiler/ast/ast").DoWhileStatement).condition);
        return;
      case "ForStatement":
        if ((statement as import("compiler/ast/ast").ForStatement).initializer?.kind === "VarStatement") {
          visitStatement((statement as import("compiler/ast/ast").ForStatement).initializer as import("compiler/ast/ast").Statement);
        } else if ((statement as import("compiler/ast/ast").ForStatement).initializer) {
          visitExpression((statement as import("compiler/ast/ast").ForStatement).initializer as import("compiler/ast/ast").Expr);
        }
        if ((statement as import("compiler/ast/ast").ForStatement).iterator?.kind === "VarStatement") {
          visitStatement((statement as import("compiler/ast/ast").ForStatement).iterator as import("compiler/ast/ast").Statement);
        } else if ((statement as import("compiler/ast/ast").ForStatement).iterator?.kind !== "Identifier" && (statement as import("compiler/ast/ast").ForStatement).iterator) {
          visitExpression((statement as import("compiler/ast/ast").ForStatement).iterator as import("compiler/ast/ast").Expr);
        }
        if ((statement as import("compiler/ast/ast").ForStatement).iterable) {
          visitExpression((statement as import("compiler/ast/ast").ForStatement).iterable!);
        }
        if ((statement as import("compiler/ast/ast").ForStatement).condition) {
          visitExpression((statement as import("compiler/ast/ast").ForStatement).condition!);
        }
        if ((statement as import("compiler/ast/ast").ForStatement).update) {
          visitExpression((statement as import("compiler/ast/ast").ForStatement).update!);
        }
        visitStatement((statement as import("compiler/ast/ast").ForStatement).body);
        return;
      case "SwitchStatement":
        visitExpression((statement as import("compiler/ast/ast").SwitchStatement).discriminant);
        for (const switchCase of (statement as import("compiler/ast/ast").SwitchStatement).cases) {
          if (switchCase.test) {
            visitExpression(switchCase.test);
          }
          for (const child of switchCase.consequent) {
            visitStatement(child);
          }
        }
        return;
      case "TryStatement":
        for (const child of (statement as import("compiler/ast/ast").TryStatement).tryBlock.body) {
          visitStatement(child);
        }
        if ((statement as import("compiler/ast/ast").TryStatement).catchClause) {
          for (const child of (statement as import("compiler/ast/ast").TryStatement).catchClause!.body.body) {
            visitStatement(child);
          }
        }
        if ((statement as import("compiler/ast/ast").TryStatement).finallyBlock) {
          for (const child of (statement as import("compiler/ast/ast").TryStatement).finallyBlock!.body) {
            visitStatement(child);
          }
        }
        return;
      default:
        return;
    }
  };

  for (const statement of ast.body) {
    visitStatement(statement);
  }

  return inferred;
}

export function createCreateMemberCodeActions(params: {
  uri: string;
  ast: Program | null;
  analysis?: Analysis | null;
  diagnostics: Diagnostic[];
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null;
}): CodeAction[] {
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

    const classTarget = resolveClassTarget({
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
    const existingMember = resolveClassMember(
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
