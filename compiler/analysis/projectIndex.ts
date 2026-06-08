import { extname, resolve } from "node:path";
import type { Analysis } from "./Analysis";
import type {
  ClassStatement,
  FunctionStatement,
  Identifier,
  InterfaceStatement,
  ImportStatement,
  Program,
  TypeAliasStatement,
  VarStatement,
  ExportStatement,
  Statement
} from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { compileSource } from "compiler/pipeline/compile";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import { localVfs, type Vfs } from "compiler/vfs";

export interface ProjectSessionLike {
  ast: Program | null;
  analysis: Analysis | null;
}

export interface ProjectContext {
  sourceRoots?: string[];
  vfs?: Vfs;
  getSessionForFilePath?: (filePath: string) => ProjectSessionLike | null | Promise<ProjectSessionLike | null>;
}

export type ProjectTopLevelDeclarationKind = "class" | "interface" | "type" | "function" | "variable";

export interface ProjectTopLevelDeclaration {
  name: string;
  kind: ProjectTopLevelDeclarationKind;
  receiverType?: string;
  memberKind?: "property" | "method";
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

function extensionMemberMetadata(
  receiverType: Identifier | undefined,
  memberKind: "property" | "method"
): Pick<ProjectTopLevelDeclaration, "receiverType" | "memberKind"> {
  if (!receiverType) {
    return {};
  }
  return {
    receiverType: receiverType.name,
    memberKind
  };
}

function pushVariableDeclarations(
  declarations: ProjectTopLevelDeclaration[],
  variableStatement: VarStatement,
  bindingNames: Iterable<Identifier>
): void {
  for (const identifier of bindingNames) {
    const range = nodeRange(identifier);
    if (!range) {
      continue;
    }
    declarations.push({
      name: identifier.name,
      kind: "variable",
      ...extensionMemberMetadata(variableStatement.receiverType, "property"),
      range
    });
  }
}

export function collectTopLevelDeclarationsFromAst(ast: Program | null): ProjectTopLevelDeclaration[] {
  if (!ast) {
    return [];
  }
  const declarations: ProjectTopLevelDeclaration[] = [];

  for (const originalStatement of ast.body) {
    const statement: Statement = originalStatement.kind === "ExportStatement" && (originalStatement as ExportStatement).declaration
      ? (originalStatement as ExportStatement).declaration!
      : originalStatement;
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

    if (statement.kind === "InterfaceStatement") {
      const interfaceStatement = statement as InterfaceStatement;
      const range = nodeRange(interfaceStatement.name);
      if (range) {
        declarations.push({
          name: interfaceStatement.name.name,
          kind: "interface",
          range
        });
      }
      continue;
    }

    if (statement.kind === "TypeAliasStatement") {
      const typeAliasStatement = statement as TypeAliasStatement;
      const range = nodeRange(typeAliasStatement.name);
      if (range) {
        declarations.push({
          name: typeAliasStatement.name.name,
          kind: "type",
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
          ...extensionMemberMetadata(functionStatement.receiverType, "method"),
          range
        });
      }
      continue;
    }

    if (statement.kind === "VarStatement") {
      const variableStatement = statement as VarStatement;
      if (variableStatement.declarations && variableStatement.declarations.length > 0) {
        for (const declaration of variableStatement.declarations) {
          pushVariableDeclarations(declarations, variableStatement, bindingIdentifiers(declaration.name));
        }
      } else {
        pushVariableDeclarations(declarations, variableStatement, bindingIdentifiers(variableStatement.name));
      }
      continue;
    }
  }

  return declarations;
}

async function indexFileData(ast: Program | null, filePath: string, vfs: Vfs): Promise<IndexedFileData> {
  if (!ast) {
    return { declarations: [], imports: [] };
  }

  const declarations = collectTopLevelDeclarationsFromAst(ast);
  const imports: ProjectImportBinding[] = [];

  for (const originalStatement of ast.body) {
    const statement: Statement = originalStatement.kind === "ExportStatement" && (originalStatement as ExportStatement).declaration
      ? (originalStatement as ExportStatement).declaration!
      : originalStatement;

    if (statement.kind === "ImportStatement") {
      const importStatement = statement as ImportStatement;
      const targetFilePath = await resolveImportTargetFilePath(filePath, importStatement.from.value, { vfs });
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

const VFS_KEYS = new WeakMap<Vfs, number>();
let nextVfsKey = 1;

function vfsKey(vfs: Vfs): number {
  let key = VFS_KEYS.get(vfs);
  if (!key) {
    key = nextVfsKey;
    nextVfsKey += 1;
    VFS_KEYS.set(vfs, key);
  }
  return key;
}

function rootsKey(sourceRoots: string[], vfs: Vfs = localVfs): string {
  const roots = sourceRoots.length === 0
    ? "<empty>"
    : [...sourceRoots].map((root) => resolve(root)).sort().join("|");
  return `${vfsKey(vfs)}:${roots}`;
}

export class ProjectIndex {
  private readonly sourceRoots: string[];
  private readonly diskSessions = new Map<string, CachedDiskSession>();
  private readonly openOverrides = new Map<string, OpenFileOverride>();

  constructor(sourceRoots: string[], private readonly vfs: Vfs = localVfs) {
    this.sourceRoots = [...sourceRoots];
  }

  setSourceRoots(sourceRoots: string[]): void {
    this.sourceRoots.length = 0;
    this.sourceRoots.push(...sourceRoots);
  }

  async scanMyFiles(): Promise<string[]> {
    const files: string[] = [];
    const stack = [...this.sourceRoots];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      const entries = await this.vfs.readDir(current);
      if (!entries) {
        continue;
      }

      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        const fullPath = resolve(current, entry.name);
        if (entry.isDirectory) {
          stack.push(fullPath);
        } else if (entry.isFile && extname(entry.name) === ".my") {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  async upsertOpenDocument(filePath: string, source: string): Promise<void> {
    const normalized = resolve(filePath);
    const session = compileToSession(source);
    const indexed = await indexFileData(session.ast, normalized, this.vfs);
    this.openOverrides.set(normalized, { session, indexed });
  }

  clearOpenDocument(filePath: string): void {
    this.openOverrides.delete(resolve(filePath));
  }

  invalidateFile(filePath: string): void {
    this.diskSessions.delete(resolve(filePath));
  }

  private async getDiskSession(filePath: string): Promise<CachedDiskSession | null> {
    const normalized = resolve(filePath);
    const fileStats = await this.vfs.stat(normalized);
    if (!fileStats || fileStats.isFile === false) {
      return null;
    }
    const cached = this.diskSessions.get(normalized);
    if (cached && cached.mtimeMs === fileStats.mtimeMs) {
      return cached;
    }

    const source = await this.vfs.readFile(normalized);
    if (source === null) {
      return null;
    }
    const session = compileToSession(source);
    const indexed = await indexFileData(session.ast, normalized, this.vfs);
    const next: CachedDiskSession = {
      mtimeMs: fileStats.mtimeMs,
      session,
      indexed
    };
    this.diskSessions.set(normalized, next);
    return next;
  }

  async getSessionForFilePath(filePath: string): Promise<ProjectSessionLike | null> {
    const normalized = resolve(filePath);
    const open = this.openOverrides.get(normalized);
    if (open) {
      return open.session;
    }

    const disk = await this.getDiskSession(normalized);
    return disk?.session ?? null;
  }

  async getIndexedFileData(filePath: string): Promise<IndexedFileData | null> {
    const normalized = resolve(filePath);
    const open = this.openOverrides.get(normalized);
    if (open) {
      return open.indexed;
    }
    const disk = await this.getDiskSession(normalized);
    return disk?.indexed ?? null;
  }

  async findTopLevelDeclaration(filePath: string, name: string): Promise<ProjectTopLevelDeclaration | null> {
    const indexed = await this.getIndexedFileData(filePath);
    if (!indexed) {
      return null;
    }
    return indexed.declarations.find((declaration) => declaration.name === name) ?? null;
  }

  async findFilesImportingSymbol(targetFilePath: string, symbolName: string): Promise<Array<{
    importerFilePath: string;
    importRange: ProjectImportBinding["range"];
  }>> {
    const normalizedTarget = resolve(targetFilePath);
    const matches: Array<{
      importerFilePath: string;
      importRange: ProjectImportBinding["range"];
    }> = [];

    for (const importerFilePath of await this.scanMyFiles()) {
      const indexed = await this.getIndexedFileData(importerFilePath);
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

  async collectWorkspaceTopLevelDeclarations(query: string): Promise<Array<{
    filePath: string;
    declaration: ProjectTopLevelDeclaration;
  }>> {
    const normalizedQuery = query.trim().toLowerCase();
    const matches: Array<{
      filePath: string;
      declaration: ProjectTopLevelDeclaration;
    }> = [];

    for (const filePath of await this.scanMyFiles()) {
      const indexed = await this.getIndexedFileData(filePath);
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

export function getProjectIndex(sourceRoots: string[], vfs: Vfs = localVfs): ProjectIndex {
  const key = rootsKey(sourceRoots, vfs);
  const existing = PROJECT_INDEXES.get(key);
  if (existing) {
    existing.setSourceRoots(sourceRoots);
    return existing;
  }
  const created = new ProjectIndex(sourceRoots, vfs);
  PROJECT_INDEXES.set(key, created);
  return created;
}

export async function scanProjectMyFiles(sourceRoots: string[], vfs: Vfs = localVfs): Promise<string[]> {
  return getProjectIndex(sourceRoots, vfs).scanMyFiles();
}

export async function getProjectSessionForFilePath(
  filePath: string,
  context: ProjectContext
): Promise<ProjectSessionLike | null> {
  if (context.getSessionForFilePath) {
    const provided = await context.getSessionForFilePath(filePath);
    if (provided) {
      return provided;
    }
  }

  const sourceRoots = context.sourceRoots ?? [];
  const index = getProjectIndex(sourceRoots, context.vfs);
  return index.getSessionForFilePath(filePath);
}
