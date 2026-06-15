/**
 * Shared cross-file navigation context: resolve-context/session contracts,
 * import-target resolution, canonical top-level symbol resolution, and the
 * local (same-file) reference/rename fallbacks used by every cross-file
 * navigation operation.
 */
import type { Location, WorkspaceEdit } from "vscode-languageserver/node.js";
import { findTopLevelDeclarationInProgram, topLevelDeclarationNames } from "./declarationResolver";
import { uriToFilePath } from "./importFixes";
import { getProjectIndex, getProjectSessionForFilePath } from "./projectAnalysis";
import { containsPosition, nodeRange } from "./ranges";
import { createReferences, createRenameWorkspaceEdit } from "./navigation";
import type { Analysis } from "compiler/analysis/Analysis";
import type { AnnotationStatement, ClassStatement, FunctionStatement, ImportStatement, InterfaceStatement, Program, Statement, VarStatement } from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { candidateImportTargetFilePaths, resolveImportTargetFilePath } from "compiler/moduleResolution";
import { getDomDeclarationFilePath, isDomRuntimeNode } from "compiler/runtime/domDeclarations";
import {
  getEcmaScriptRuntimeDeclarationFilePath,
  getVexaScriptRuntimeDeclarationFilePath,
  isEcmaScriptRuntimeNode,
  isVexaScriptRuntimeNode
} from "compiler/runtime/ecmascriptDeclarations";
import { dirname, resolve } from "compiler/utils/path";
import { vfs } from "compiler/vfs";

export interface SessionLike {
  ast: Program | null;
  analysis: Analysis | null;
  ambientDeclarations?: Statement[];
  ambientModuleDeclarations?: ReadonlyMap<string, Statement[]>;
  ambientModuleLocations?: ReadonlyMap<string, { filePath: string; line: number; character: number }>;
}

export interface ResolveContext {
  uri: string;
  line: number;
  character: number;
  session: SessionLike;
  sourceRoots: string[];
  vfs?: import("compiler/vfs").Vfs;
  getSessionForFilePath?: (filePath: string) => SessionLike | null | Promise<SessionLike | null>;
}

export function effectiveSourceRoots(
  sourceRoots: string[],
  fallbackFilePath: string | null
): string[] {
  if (sourceRoots.length > 0) {
    return sourceRoots;
  }
  if (!fallbackFilePath) {
    return [];
  }
  const fallbackRoot = dirname(fallbackFilePath);
  return fallbackRoot === "/" ? [] : [fallbackRoot];
}

export const VIRTUAL_DOM_DECLARATION_FILE_PATH = "/runtime/dom.d.ts";
export const VIRTUAL_ECMA_DECLARATION_FILE_PATH = "/runtime/es2025.d.ts";
export const VIRTUAL_VEXA_DECLARATION_FILE_PATH = "/runtime/vexascript.d.vx";

export interface CanonicalSymbol {
  name: string;
  filePath: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export function localReferencesFromContext(
  context: ResolveContext,
  includeDeclaration: boolean
): Location[] {
  if (!context.session.analysis || !context.session.ast) {
    return [];
  }
  return createReferences(
    context.session.analysis,
    context.uri,
    context.line,
    context.character,
    includeDeclaration,
    context.session.ast
  );
}

export function localRenameWorkspaceEdit(context: ResolveContext, newName: string): WorkspaceEdit | null {
  if (!context.session.analysis || !context.session.ast) {
    return null;
  }
  return createRenameWorkspaceEdit(
    context.session.analysis,
    context.uri,
    context.line,
    context.character,
    newName,
    context.session.ast
  );
}

export function findImportForSymbolNode(ast: Program, symbolNode: unknown): { from: string; name: string } | null {
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    for (const specifier of importStatement.specifiers) {
      if (specifier.imported === symbolNode || specifier.local === symbolNode) {
        return { from: importStatement.from.value, name: specifier.imported.name };
      }
    }
  }
  return null;
}

export function findTopLevelDeclarationByName(ast: Program, name: string): Statement | null {
  return findTopLevelDeclarationInProgram(
    ast,
    name,
    (statement): statement is Statement => topLevelDeclarationNames(statement).includes(name)
  );
}

export function declarationRangeForName(statement: Statement, name: string) {
  if (statement.kind === "VarStatement") {
    const variableStatement = statement as VarStatement;
    if (variableStatement.declarations && variableStatement.declarations.length > 0) {
      for (const declaration of variableStatement.declarations) {
        const identifier = bindingIdentifiers(declaration.name).find((item) => item.name === name);
        if (identifier) return nodeRange(identifier);
      }
    }
    return nodeRange(bindingIdentifiers(variableStatement.name).find((item) => item.name === name) ?? variableStatement.name);
  }
  if (statement.kind === "ClassStatement") {
    return nodeRange((statement as ClassStatement).name);
  }
  if (statement.kind === "AnnotationStatement") {
    return nodeRange((statement as AnnotationStatement).name);
  }
  if (statement.kind === "InterfaceStatement") {
    return nodeRange((statement as InterfaceStatement).name);
  }
  if (statement.kind === "FunctionStatement") {
    return nodeRange((statement as FunctionStatement).name);
  }
  return nodeRange(statement);
}

export async function getSessionForFilePath(filePath: string, context: ResolveContext): Promise<SessionLike | null> {
  return getProjectSessionForFilePath(filePath, {
    sourceRoots: context.sourceRoots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });
}

export async function preferVirtualRuntimeDeclarationFilePath(
  filePath: string,
  context: ResolveContext
): Promise<string> {
  const virtualCandidate = filePath === getDomDeclarationFilePath() || filePath.endsWith("/dom.d.ts")
    ? VIRTUAL_DOM_DECLARATION_FILE_PATH
    : filePath === await getEcmaScriptRuntimeDeclarationFilePath() || filePath.endsWith("/es2025.d.ts")
      ? VIRTUAL_ECMA_DECLARATION_FILE_PATH
      : filePath === await getVexaScriptRuntimeDeclarationFilePath() || filePath.endsWith("/vexascript.d.vx")
        ? VIRTUAL_VEXA_DECLARATION_FILE_PATH
      : null;
  if (!virtualCandidate) {
    return filePath;
  }

  if (context.getSessionForFilePath) {
    const session = await context.getSessionForFilePath(virtualCandidate);
    if (session?.ast) {
      return virtualCandidate;
    }
  }

  if (context.vfs && await context.vfs.fileExists(virtualCandidate)) {
    return virtualCandidate;
  }

  return filePath;
}

async function runtimeDeclarationRangeForName(
  context: ResolveContext,
  filePath: string,
  symbolName: string
): Promise<CanonicalSymbol["range"] | null> {
  const source = await readTextDocument(context, filePath);
  if (!source) {
    return null;
  }
  const patterns = [
    `declare function ${symbolName}(`,
    `declare var ${symbolName}:`,
    `declare const ${symbolName}:`,
    `declare class ${symbolName}`,
    `interface ${symbolName} `,
    `interface ${symbolName}{`,
    `type ${symbolName} =`,
    `declare namespace ${symbolName}`,
    `namespace ${symbolName}`,
  ];
  const lines = source.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    for (const pattern of patterns) {
      const patternIndex = line.indexOf(pattern);
      if (patternIndex < 0) {
        continue;
      }
      const symbolIndex = line.indexOf(symbolName, patternIndex);
      if (symbolIndex < 0) {
        continue;
      }
      return {
        start: { line: lineIndex, character: symbolIndex },
        end: { line: lineIndex, character: symbolIndex + symbolName.length }
      };
    }
  }
  return null;
}

export async function resolveImportTargetInContext(
  importerFilePath: string,
  importPath: string,
  context: ResolveContext
): Promise<string | null> {
  const diskPath = await resolveImportTargetFilePath(importerFilePath, importPath, { vfs: context.vfs });
  if (diskPath || !context.getSessionForFilePath) {
    return diskPath;
  }
  for (const candidate of candidateImportTargetFilePaths(importerFilePath, importPath)) {
    const session = await getSessionForFilePath(candidate, context);
    if (session?.ast) {
      return candidate;
    }
  }
  return null;
}

/**
 * Whether `declaration` introduces `symbolNode` as its declared name. The
 * analysis stores the declaration's name identifier (not the statement) as a
 * symbol node, so matching is done against the declaration's name node(s).
 */
export function declarationDeclaresNode(declaration: Statement, symbolNode: unknown): boolean {
  if (declaration === symbolNode) {
    return true;
  }
  const named = declaration as { name?: unknown };
  if (named.name === symbolNode) {
    return true;
  }
  if (declaration.kind === "VarStatement") {
    const variableStatement = declaration as VarStatement;
    const names = [
      ...bindingIdentifiers(variableStatement.name),
      ...(variableStatement.declarations ?? []).flatMap((item) => bindingIdentifiers(item.name))
    ];
    return names.some((identifier) => identifier === symbolNode);
  }
  return false;
}

/**
 * Finds the imported file that owns `symbolNode` and returns a canonical symbol
 * pointing at the declaration there. Used when a symbol resolved through an
 * external declaration (e.g. a cross-file operator overload) carries a node that
 * lives in an imported file rather than the current document. Declarations are
 * matched by node identity because the analysis registers the very same AST
 * nodes parsed from the imported file as external declarations.
 */
export async function resolveExternalDeclarationLocation(
  context: ResolveContext,
  currentFilePath: string,
  symbolNode: unknown,
  symbolName: string
): Promise<CanonicalSymbol | null> {
  const ast = context.session.ast;
  if (!ast) {
    return null;
  }
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const targetFilePath = await resolveImportTargetInContext(currentFilePath, (statement as ImportStatement).from.value, context);
    if (!targetFilePath) {
      continue;
    }
    const targetSession = await getSessionForFilePath(targetFilePath, context);
    if (!targetSession?.ast) {
      continue;
    }
    for (const targetStatement of targetSession.ast.body) {
      const declaration = unwrapExportedDeclaration(targetStatement);
      if (declaration && declarationDeclaresNode(declaration, symbolNode)) {
        const range = declarationRangeForName(declaration, symbolName);
        if (!range) {
          continue;
        }
        return {
          name: symbolName,
          filePath: targetFilePath,
          range
        };
      }
    }
  }
  return null;
}

export async function resolveCanonicalSymbol(context: ResolveContext): Promise<CanonicalSymbol | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.analysis || !context.session.ast) {
    return null;
  }

  const definition = context.session.analysis.getDefinitionAt(context.line, context.character);
  const symbolAt =
    context.session.analysis.getSymbolAt(context.line, context.character) ??
    context.session.analysis.getOperatorSymbolAt(context.line, context.character);
  if (!definition || !symbolAt) {
    return null;
  }

  const importBinding = findImportForSymbolNode(context.session.ast, symbolAt.symbol.node);
    if (!importBinding) {
      if (isEcmaScriptRuntimeNode(symbolAt.symbol.node)) {
        const filePath = await preferVirtualRuntimeDeclarationFilePath(
          await getEcmaScriptRuntimeDeclarationFilePath(),
          context
        );
        return {
          name: symbolAt.symbol.name,
          filePath,
          range: await runtimeDeclarationRangeForName(context, filePath, symbolAt.symbol.name) ?? definition.range
        };
      }
      if (isVexaScriptRuntimeNode(symbolAt.symbol.node)) {
        const filePath = await preferVirtualRuntimeDeclarationFilePath(
          await getVexaScriptRuntimeDeclarationFilePath(),
          context
        );
        return {
          name: symbolAt.symbol.name,
          filePath,
          range: await runtimeDeclarationRangeForName(context, filePath, symbolAt.symbol.name) ?? definition.range
        };
      }
      if (isDomRuntimeNode(symbolAt.symbol.node)) {
        const filePath = await preferVirtualRuntimeDeclarationFilePath(
          getDomDeclarationFilePath(),
          context
        );
        return {
          name: symbolAt.symbol.name,
          filePath,
          range: await runtimeDeclarationRangeForName(context, filePath, symbolAt.symbol.name) ?? definition.range
        };
      }
    // Symbols resolved through external (imported) declarations - e.g. a
    // cross-file operator overload reached from a `a + b` usage - carry a node
    // that belongs to the imported file, not the current document. Locate the
    // owning file so navigation lands there instead of the current file.
    const externalLocation = await resolveExternalDeclarationLocation(
      context,
      currentFilePath,
      symbolAt.symbol.node,
      symbolAt.symbol.name
    );
    if (externalLocation) {
      return externalLocation;
    }
    return {
      name: symbolAt.symbol.name,
      filePath: currentFilePath,
      range: definition.range
    };
  }

  const targetFilePath = await resolveImportTargetInContext(currentFilePath, importBinding.from, context);
  if (!targetFilePath) {
    return {
      name: symbolAt.symbol.name,
      filePath: currentFilePath,
      range: definition.range
    };
  }

  const targetSession = await getSessionForFilePath(targetFilePath, context);
  if (!targetSession?.ast) {
    return {
      name: symbolAt.symbol.name,
      filePath: currentFilePath,
      range: definition.range
    };
  }

  const projectIndex = getProjectIndex(context.sourceRoots, context.vfs);
  const indexedDeclaration = await projectIndex.findTopLevelDeclaration(targetFilePath, importBinding.name);
  const astDeclaration = findTopLevelDeclarationByName(targetSession.ast, importBinding.name);
  const targetRange = indexedDeclaration?.range ?? (astDeclaration ? declarationRangeForName(astDeclaration, importBinding.name) : null);
  if (!targetRange) {
    return {
      name: symbolAt.symbol.name,
      filePath: currentFilePath,
      range: definition.range
    };
  }

  return {
    name: importBinding.name,
    filePath: targetFilePath,
    range: targetRange
  };
}

export function rangesEqual(
  a: { start: { line: number; character: number }; end: { line: number; character: number } },
  b: { start: { line: number; character: number }; end: { line: number; character: number } }
): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

export async function findMatchingImportSpecifierPositions(
  importerAst: Program,
  importerFilePath: string,
  symbol: CanonicalSymbol,
  context: ResolveContext
): Promise<Array<{ line: number; character: number }>> {
  const positions: Array<{ line: number; character: number }> = [];
  for (const statement of importerAst.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const targetFilePath = await resolveImportTargetFilePath(importerFilePath, importStatement.from.value, { vfs: context.vfs });
    if (!targetFilePath || resolve(targetFilePath) !== resolve(symbol.filePath)) {
      continue;
    }
    for (const specifier of importStatement.specifiers) {
      if (specifier.imported.name !== symbol.name || !specifier.imported.firstToken) {
        continue;
      }
      positions.push({
        line: specifier.imported.firstToken.range.start.line,
        character: specifier.imported.firstToken.range.start.column
      });
    }
  }
  return positions;
}

export async function readTextDocument(context: ResolveContext, filePath: string): Promise<string | null> {
  const virtualSource = await context.vfs?.readFile?.(filePath);
  if (typeof virtualSource === "string") {
    return virtualSource;
  }
  try {
    return await vfs().readFile(filePath);
  } catch {
    return null;
  }
}

export function findImportStringLiteralAtPosition(
  ast: Program,
  line: number,
  character: number
): ImportStatement | null {
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") continue;
    const importStatement = statement as ImportStatement;
    const fromRange = nodeRange(importStatement.from);
    if (fromRange && containsPosition(fromRange, { line, character })) {
      return importStatement;
    }
  }
  return null;
}
