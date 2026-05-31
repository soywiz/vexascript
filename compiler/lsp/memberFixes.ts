import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type {
  ClassStatement,
  ImportStatement,
  Program
} from "compiler/ast/ast";
import { compileSource } from "compiler/pipeline/compile";
import type { Analysis } from "compiler/analysis/Analysis";
import { type AnalysisType, typeToString } from "compiler/analysis/types";
import type { CodeAction, Diagnostic, Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "vscode-languageserver/node.js";
import { pathToUri, uriToFilePath } from "./importFixes";
import {
  isMissingMemberDiagnostic,
  MISSING_MEMBER_PATTERN
} from "./diagnosticCodes";

interface SessionLike {
  ast: Program | null;
  analysis: Analysis | null;
}

interface ClassResolution {
  classStatement: ClassStatement;
  filePath: string;
}

interface MissingMemberDiagnosticMatch {
  memberName: string;
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
  const className = match[2];
  if (!memberName || !className) {
    return null;
  }
  return { memberName, className };
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

function findClassStatement(ast: Program, className: string): ClassStatement | null {
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

function readSessionForFilePath(
  filePath: string,
  getSessionForFilePath?: (filePath: string) => SessionLike | null
): SessionLike | null {
  if (getSessionForFilePath) {
    const fromProvider = getSessionForFilePath(filePath);
    if (fromProvider) {
      return fromProvider;
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

function classHasMember(classStatement: ClassStatement, memberName: string): boolean {
  for (const parameter of classStatement.primaryConstructorParameters ?? []) {
    if (parameter.name.name === memberName) {
      return true;
    }
  }
  for (const member of classStatement.members) {
    if (member.name.name === memberName) {
      return true;
    }
  }
  return false;
}

function classFromImports(
  ast: Program,
  currentFilePath: string,
  className: string,
  getSessionForFilePath?: (filePath: string) => SessionLike | null
): ClassResolution | null {
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
    const session = readSessionForFilePath(targetFilePath, getSessionForFilePath);
    if (!session?.ast) {
      continue;
    }
    const classStatement = findClassStatement(session.ast, className);
    if (!classStatement) {
      continue;
    }
    return {
      classStatement,
      filePath: targetFilePath
    };
  }
  return null;
}

function resolveClassTarget(params: {
  currentUri: string;
  currentAst: Program;
  className: string;
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => SessionLike | null;
}): ClassResolution | null {
  const currentFilePath = uriToFilePath(params.currentUri);
  if (!currentFilePath) {
    return null;
  }

  const local = findClassStatement(params.currentAst, params.className);
  if (local) {
    return { classStatement: local, filePath: currentFilePath };
  }

  const imported = classFromImports(
    params.currentAst,
    currentFilePath,
    params.className,
    params.getSessionForFilePath
  );
  if (imported) {
    return imported;
  }

  for (const filePath of scanMyFiles(params.sourceRoots)) {
    const session = readSessionForFilePath(filePath, params.getSessionForFilePath);
    if (!session?.ast) {
      continue;
    }
    const classStatement = findClassStatement(session.ast, params.className);
    if (classStatement) {
      return {
        classStatement,
        filePath
      };
    }
  }

  return null;
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
          visitExpression(property.value);
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
  getSessionForFilePath?: (filePath: string) => SessionLike | null;
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
    const { className, memberName } = parsed;

    const classTarget = resolveClassTarget({
      currentUri: uri,
      currentAst: ast,
      className,
      sourceRoots,
      ...(params.getSessionForFilePath
        ? { getSessionForFilePath: params.getSessionForFilePath }
        : {})
    });
    if (!classTarget) {
      continue;
    }
    if (classHasMember(classTarget.classStatement, memberName)) {
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
