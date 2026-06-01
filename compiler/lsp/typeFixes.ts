import type { Analysis } from "compiler/analysis/Analysis";
import { baseTypeName } from "compiler/analysis/typeNames";
import type {
  ArrayLiteral,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  ClassStatement,
  ConditionalExpression,
  DoWhileStatement,
  Expr,
  ExprStatement,
  ForStatement,
  FunctionStatement,
  Identifier,
  IfStatement,
  MemberExpression,
  NewExpression,
  ObjectLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
  Statement,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement
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

interface FindAssignmentResult {
  assignment: AssignmentExpression;
  range: Range;
  size: number;
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

function rangeContains(outer: Range, inner: Range): boolean {
  const startsBefore =
    outer.start.line < inner.start.line ||
    (outer.start.line === inner.start.line &&
      outer.start.character <= inner.start.character);
  const endsAfter =
    outer.end.line > inner.end.line ||
    (outer.end.line === inner.end.line &&
      outer.end.character >= inner.end.character);
  return startsBefore && endsAfter;
}

function rangeSize(range: Range): number {
  const lineSpan = range.end.line - range.start.line;
  if (lineSpan > 0) {
    return lineSpan * 100000 + (range.end.character - range.start.character);
  }
  return range.end.character - range.start.character;
}

function findAssignmentForDiagnosticRange(ast: Program, diagnosticRange: Range): AssignmentExpression | null {
  let best: FindAssignmentResult | null = null;

  const consider = (assignment: AssignmentExpression): void => {
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
  };

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "AssignmentExpression": {
        const assignment = expression as AssignmentExpression;
        consider(assignment);
        visitExpression(assignment.left);
        visitExpression(assignment.right);
        return;
      }
      case "CallExpression":
        visitExpression((expression as CallExpression).callee);
        for (const argument of (expression as CallExpression).arguments) {
          visitExpression(argument);
        }
        return;
      case "MemberExpression":
        visitExpression((expression as MemberExpression).object);
        if ((expression as MemberExpression).computed) {
          visitExpression((expression as MemberExpression).property);
        }
        return;
      case "NewExpression":
        visitExpression((expression as NewExpression).callee);
        for (const argument of (expression as NewExpression).arguments ?? []) {
          visitExpression(argument);
        }
        return;
      case "BinaryExpression":
        visitExpression((expression as BinaryExpression).left);
        visitExpression((expression as BinaryExpression).right);
        return;
      case "RangeExpression":
        visitExpression((expression as RangeExpression).start);
        visitExpression((expression as RangeExpression).end);
        return;
      case "ConditionalExpression":
        visitExpression((expression as ConditionalExpression).test);
        visitExpression((expression as ConditionalExpression).consequent);
        visitExpression((expression as ConditionalExpression).alternate);
        return;
      case "UnaryExpression":
      case "UpdateExpression":
        visitExpression((expression as UnaryExpression | UpdateExpression).argument);
        return;
      case "ArrayLiteral":
        for (const element of (expression as ArrayLiteral).elements) {
          visitExpression(element);
        }
        return;
      case "ObjectLiteral":
        for (const property of (expression as ObjectLiteral).properties) {
          visitExpression(property.value);
        }
        return;
      default:
        return;
    }
  };

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "VarStatement":
        if ((statement as VarStatement).declarations?.length) {
          for (const declaration of (statement as VarStatement).declarations ?? []) {
            if (declaration.initializer) {
              visitExpression(declaration.initializer);
            }
          }
        } else if ((statement as VarStatement).initializer) {
          visitExpression((statement as VarStatement).initializer!);
        }
        return;
      case "ExprStatement":
        visitExpression((statement as ExprStatement).expression);
        return;
      case "ReturnStatement":
        if ((statement as ReturnStatement).expression) {
          visitExpression((statement as ReturnStatement).expression!);
        }
        return;
      case "ThrowStatement":
        visitExpression((statement as ThrowStatement).expression);
        return;
      case "BlockStatement":
        for (const child of (statement as BlockStatement).body) {
          visitStatement(child);
        }
        return;
      case "FunctionStatement":
        for (const child of (statement as FunctionStatement).body.body) {
          visitStatement(child);
        }
        return;
      case "ClassStatement":
        for (const member of (statement as ClassStatement).members) {
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
        visitExpression((statement as IfStatement).condition);
        visitStatement((statement as IfStatement).thenBranch);
        if ((statement as IfStatement).elseBranch) {
          visitStatement((statement as IfStatement).elseBranch!);
        }
        return;
      case "WhileStatement":
        visitExpression((statement as WhileStatement).condition);
        visitStatement((statement as WhileStatement).body);
        return;
      case "DoWhileStatement":
        visitStatement((statement as DoWhileStatement).body);
        visitExpression((statement as DoWhileStatement).condition);
        return;
      case "ForStatement":
        if ((statement as ForStatement).initializer?.kind === "VarStatement") {
          visitStatement((statement as ForStatement).initializer as Statement);
        } else if ((statement as ForStatement).initializer) {
          visitExpression((statement as ForStatement).initializer as Expr);
        }
        if ((statement as ForStatement).iterator?.kind === "VarStatement") {
          visitStatement((statement as ForStatement).iterator as Statement);
        } else if ((statement as ForStatement).iterator?.kind !== "Identifier" && (statement as ForStatement).iterator) {
          visitExpression((statement as ForStatement).iterator as Expr);
        }
        if ((statement as ForStatement).iterable) {
          visitExpression((statement as ForStatement).iterable!);
        }
        if ((statement as ForStatement).condition) {
          visitExpression((statement as ForStatement).condition!);
        }
        if ((statement as ForStatement).update) {
          visitExpression((statement as ForStatement).update!);
        }
        visitStatement((statement as ForStatement).body);
        return;
      case "SwitchStatement":
        visitExpression((statement as SwitchStatement).discriminant);
        for (const switchCase of (statement as SwitchStatement).cases) {
          if (switchCase.test) {
            visitExpression(switchCase.test);
          }
          for (const child of switchCase.consequent) {
            visitStatement(child);
          }
        }
        return;
      case "TryStatement":
        for (const child of (statement as TryStatement).tryBlock.body) {
          visitStatement(child);
        }
        if ((statement as TryStatement).catchClause) {
          for (const child of (statement as TryStatement).catchClause!.body.body) {
            visitStatement(child);
          }
        }
        if ((statement as TryStatement).finallyBlock) {
          for (const child of (statement as TryStatement).finallyBlock!.body) {
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

  const resolvedBest = best as FindAssignmentResult | null;
  if (resolvedBest) {
    return resolvedBest.assignment;
  }
  return null;
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

export function createTypeFixCodeActions(params: {
  uri: string;
  ast: Program | null;
  analysis: Analysis | null;
  diagnostics: Diagnostic[];
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => { ast: Program | null; analysis: Analysis | null } | null;
  commandName?: string;
}): CodeAction[] {
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

    const objectType = resolveExpressionTypeName(
      leftMember.object,
      params.analysis,
      params.ast,
      resolverOptions
    );
    if (!objectType) {
      continue;
    }

    const classResolution = resolveClassStatementAcrossFiles(
      params.ast,
      baseTypeName(objectType),
      resolverOptions,
      resolverCache
    );
    if (!classResolution) {
      continue;
    }

    const memberName = (leftMember.property as Identifier).name;
    const resolvedMember = resolveClassMember(
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

    const declaration = resolveClassMemberDeclaration(
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
