import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type {
  ClassStatement,
  ImportStatement,
  Program
} from "compiler/ast/ast";
import { compileSource } from "compiler/pipeline/compile";
import type { Analysis } from "compiler/analysis/Analysis";
import type { CodeAction, Diagnostic, Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "vscode-languageserver/node.js";
import { pathToUri, uriToFilePath } from "./importFixes";

const MISSING_MEMBER_PATTERN = /^Property '([A-Za-z_][A-Za-z0-9_]*)' does not exist on type '([A-Za-z_][A-Za-z0-9_]*)'$/;

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
  if (diagnostic.source !== "mylang-sema") {
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

export function createCreateMemberCodeActions(params: {
  uri: string;
  ast: Program | null;
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
    const memberText = newMemberText(classTarget.classStatement, memberName);
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
