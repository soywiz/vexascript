import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Analysis } from "./Analysis";
import type {
  ClassStatement,
  FunctionStatement,
  ImportStatement,
  Program,
  VarStatement
} from "compiler/ast/ast";
import { compileSource } from "compiler/pipeline/compile";

export interface ProjectSessionLike {
  ast: Program | null;
  analysis: Analysis | null;
}

export interface ProjectContext {
  sourceRoots?: string[];
  getSessionForFilePath?: (filePath: string) => ProjectSessionLike | null;
}

export interface ProjectTopLevelDeclaration {
  name: string;
  kind: "class" | "function" | "variable";
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface ProjectImportBinding {
  importedName: string;
  from: string;
  targetFilePath: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface IndexedFileData {
  declarations: ProjectTopLevelDeclaration[];
  imports: ProjectImportBinding[];
}

interface CachedDiskSession {
  mtimeMs: number;
  session: ProjectSessionLike;
  indexed: IndexedFileData;
}

interface OpenFileOverride {
  session: ProjectSessionLike;
  indexed: IndexedFileData;
}

function nodeRange(node: {
  firstToken?: { range: { start: { line: number; column: number } } };
  lastToken?: { range: { end: { line: number; column: number } } };
}): { start: { line: number; character: number }; end: { line: number; character: number } } | null {
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

function resolveImportTargetFilePath(importerFilePath: string, importPath: string): string | null {
  const baseDir = importerFilePath.replace(/[/\\][^/\\]+$/, "");
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

function indexFileData(ast: Program | null, filePath: string): IndexedFileData {
  if (!ast) {
    return { declarations: [], imports: [] };
  }

  const declarations: ProjectTopLevelDeclaration[] = [];
  const imports: ProjectImportBinding[] = [];

  for (const statement of ast.body) {
    if (statement.kind === "ClassStatement") {
      const classStatement = statement as ClassStatement;
      const range = nodeRange(classStatement.name);
      if (range) {
        declarations.push({
          name: classStatement.name.name,
          kind: "class",
          range
        });
      }
      continue;
    }

    if (statement.kind === "FunctionStatement") {
      const functionStatement = statement as FunctionStatement;
      const range = nodeRange(functionStatement.name);
      if (range) {
        declarations.push({
          name: functionStatement.name.name,
          kind: "function",
          range
        });
      }
      continue;
    }

    if (statement.kind === "VarStatement") {
      const variableStatement = statement as VarStatement;
      if (variableStatement.declarations && variableStatement.declarations.length > 0) {
        for (const declaration of variableStatement.declarations) {
          const range = nodeRange(declaration.name);
          if (!range) {
            continue;
          }
          declarations.push({
            name: declaration.name.name,
            kind: "variable",
            range
          });
        }
      } else {
        const range = nodeRange(variableStatement.name);
        if (range) {
          declarations.push({
            name: variableStatement.name.name,
            kind: "variable",
            range
          });
        }
      }
      continue;
    }

    if (statement.kind === "ImportStatement") {
      const importStatement = statement as ImportStatement;
      const targetFilePath = resolveImportTargetFilePath(filePath, importStatement.from.value);
      if (!targetFilePath) {
        continue;
      }
      for (const specifier of importStatement.specifiers) {
        const range = nodeRange(specifier.imported);
        if (!range) {
          continue;
        }
        imports.push({
          importedName: specifier.imported.name,
          from: importStatement.from.value,
          targetFilePath,
          range
        });
      }
    }
  }

  return { declarations, imports };
}

function compileToSession(source: string): ProjectSessionLike {
  const compiled = compileSource(source);
  return {
    ast: compiled.ast,
    analysis: compiled.analysis
  };
}

function rootsKey(sourceRoots: string[]): string {
  if (sourceRoots.length === 0) {
    return "<empty>";
  }
  return [...sourceRoots].map((root) => resolve(root)).sort().join("|");
}

export class ProjectIndex {
  private readonly sourceRoots: string[];
  private readonly diskSessions = new Map<string, CachedDiskSession>();
  private readonly openOverrides = new Map<string, OpenFileOverride>();

  constructor(sourceRoots: string[]) {
    this.sourceRoots = [...sourceRoots];
  }

  setSourceRoots(sourceRoots: string[]): void {
    this.sourceRoots.length = 0;
    this.sourceRoots.push(...sourceRoots);
  }

  scanMyFiles(): string[] {
    const files: string[] = [];
    const stack = [...this.sourceRoots];

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

  upsertOpenDocument(filePath: string, source: string): void {
    const normalized = resolve(filePath);
    const session = compileToSession(source);
    const indexed = indexFileData(session.ast, normalized);
    this.openOverrides.set(normalized, { session, indexed });
  }

  clearOpenDocument(filePath: string): void {
    this.openOverrides.delete(resolve(filePath));
  }

  invalidateFile(filePath: string): void {
    this.diskSessions.delete(resolve(filePath));
  }

  private getDiskSession(filePath: string): CachedDiskSession | null {
    const normalized = resolve(filePath);
    if (!existsSync(normalized)) {
      return null;
    }

    const fileStats = statSync(normalized);
    const cached = this.diskSessions.get(normalized);
    if (cached && cached.mtimeMs === fileStats.mtimeMs) {
      return cached;
    }

    const source = readFileSync(normalized, "utf8");
    const session = compileToSession(source);
    const indexed = indexFileData(session.ast, normalized);
    const next: CachedDiskSession = {
      mtimeMs: fileStats.mtimeMs,
      session,
      indexed
    };
    this.diskSessions.set(normalized, next);
    return next;
  }

  getSessionForFilePath(filePath: string): ProjectSessionLike | null {
    const normalized = resolve(filePath);
    const open = this.openOverrides.get(normalized);
    if (open) {
      return open.session;
    }

    const disk = this.getDiskSession(normalized);
    return disk?.session ?? null;
  }

  getIndexedFileData(filePath: string): IndexedFileData | null {
    const normalized = resolve(filePath);
    const open = this.openOverrides.get(normalized);
    if (open) {
      return open.indexed;
    }
    const disk = this.getDiskSession(normalized);
    return disk?.indexed ?? null;
  }

  findTopLevelDeclaration(filePath: string, name: string): ProjectTopLevelDeclaration | null {
    const indexed = this.getIndexedFileData(filePath);
    if (!indexed) {
      return null;
    }
    return indexed.declarations.find((declaration) => declaration.name === name) ?? null;
  }

  findFilesImportingSymbol(targetFilePath: string, symbolName: string): Array<{
    importerFilePath: string;
    importRange: ProjectImportBinding["range"];
  }> {
    const normalizedTarget = resolve(targetFilePath);
    const matches: Array<{
      importerFilePath: string;
      importRange: ProjectImportBinding["range"];
    }> = [];

    for (const importerFilePath of this.scanMyFiles()) {
      const indexed = this.getIndexedFileData(importerFilePath);
      if (!indexed) {
        continue;
      }

      for (const binding of indexed.imports) {
        if (
          resolve(binding.targetFilePath) === normalizedTarget &&
          binding.importedName === symbolName
        ) {
          matches.push({
            importerFilePath,
            importRange: binding.range
          });
        }
      }
    }

    return matches;
  }

  collectWorkspaceTopLevelDeclarations(query: string): Array<{
    filePath: string;
    declaration: ProjectTopLevelDeclaration;
  }> {
    const normalizedQuery = query.trim().toLowerCase();
    const matches: Array<{
      filePath: string;
      declaration: ProjectTopLevelDeclaration;
    }> = [];

    for (const filePath of this.scanMyFiles()) {
      const indexed = this.getIndexedFileData(filePath);
      if (!indexed) {
        continue;
      }
      for (const declaration of indexed.declarations) {
        if (
          normalizedQuery.length > 0 &&
          !declaration.name.toLowerCase().includes(normalizedQuery)
        ) {
          continue;
        }
        matches.push({
          filePath,
          declaration
        });
      }
    }

    return matches;
  }
}

const PROJECT_INDEXES = new Map<string, ProjectIndex>();

export function getProjectIndex(sourceRoots: string[]): ProjectIndex {
  const key = rootsKey(sourceRoots);
  const existing = PROJECT_INDEXES.get(key);
  if (existing) {
    existing.setSourceRoots(sourceRoots);
    return existing;
  }
  const created = new ProjectIndex(sourceRoots);
  PROJECT_INDEXES.set(key, created);
  return created;
}

export function scanProjectMyFiles(sourceRoots: string[]): string[] {
  return getProjectIndex(sourceRoots).scanMyFiles();
}

export function getProjectSessionForFilePath(
  filePath: string,
  context: ProjectContext
): ProjectSessionLike | null {
  if (context.getSessionForFilePath) {
    const provided = context.getSessionForFilePath(filePath);
    if (provided) {
      return provided;
    }
  }

  const sourceRoots = context.sourceRoots ?? [];
  const index = getProjectIndex(sourceRoots);
  return index.getSessionForFilePath(filePath);
}
