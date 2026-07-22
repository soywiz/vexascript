import { ImportStatement } from "compiler/ast/ast";
import { resolveNodeModulesTypingsPath } from "compiler/moduleResolution";

import type { Hover, Location } from "vscode-languageserver/node.js";
import { pathToUri, uriToFilePath } from "./importFixes";
import { nodeRange } from "./ranges";
import {
  declarationRangeForName,
  findTopLevelDeclarationByName,
  findImportStringLiteralAtPosition,
  getSessionForFilePath,
  resolveImportTargetInContext,
  type ResolveContext
} from "./crossFileContext";

export async function resolveImportPathDefinition(context: ResolveContext): Promise<Location | null> {
  if (!context.session.ast) return null;
  const importStatement = findImportStringLiteralAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (!importStatement) return null;

  const importerFilePath = uriToFilePath(context.uri);
  if (!importerFilePath) return null;
  const importPath = importStatement.from.value;

  const resolvedPath =
    await resolveImportTargetInContext(importerFilePath, importPath, context) ??
    await resolveNodeModulesTypingsPath(importerFilePath, importPath, { vfs: context.vfs });
  if (resolvedPath) {
    return {
      uri: pathToUri(resolvedPath),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    };
  }

  const ambientLoc = context.session.ambientModuleLocations?.get(importPath);
  if (ambientLoc) {
    return {
      uri: pathToUri(ambientLoc.filePath),
      range: {
        start: { line: ambientLoc.line, character: ambientLoc.character },
        end: { line: ambientLoc.line, character: ambientLoc.character }
      }
    };
  }

  return null;
}

export async function resolveImportPathHover(context: ResolveContext): Promise<Hover | null> {
  if (!context.session.ast) return null;
  const importStatement = findImportStringLiteralAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (!importStatement) return null;

  const importerFilePath = uriToFilePath(context.uri);
  if (!importerFilePath) return null;
  const importPath = importStatement.from.value;

  const resolvedPath =
    await resolveImportTargetInContext(importerFilePath, importPath, context) ??
    await resolveNodeModulesTypingsPath(importerFilePath, importPath, { vfs: context.vfs });

  const fromRange = nodeRange(importStatement.from);
  const rangeOpts = fromRange ? { range: fromRange } : {};

  if (!resolvedPath) {
    return {
      contents: { kind: "plaintext", value: `module: ${importPath} (unresolved)` },
      ...rangeOpts
    };
  }
  return {
    contents: { kind: "plaintext", value: `module: ${resolvedPath}` },
    ...rangeOpts
  };
}

/**
 * Handles the case where the cursor is on an import specifier name (e.g.,
 * `Point` in `import { Point } from "./a"`). Jumps to the declaration in the
 * target file instead of stopping at the import site.
 */
export async function resolveImportSpecifierDefinition(context: ResolveContext): Promise<Location | null> {
  if (!context.session.ast) {
    return null;
  }
  const importerFilePath = uriToFilePath(context.uri);
  if (!importerFilePath) {
    return null;
  }
  for (const statement of context.session.ast.body) {
    if (!(statement instanceof ImportStatement)) {
      continue;
    }
    const importStatement = statement as ImportStatement;
    for (const specifier of importStatement.specifiers) {
      const first = specifier.imported.firstToken;
      const last = specifier.imported.lastToken;
      if (!first || !last) {
        continue;
      }
      const afterStart =
        context.line > first.range.start.line ||
        (context.line === first.range.start.line && context.character >= first.range.start.column);
      const beforeEnd =
        context.line < last.range.end.line ||
        (context.line === last.range.end.line && context.character <= last.range.end.column);
      if (!afterStart || !beforeEnd) {
        continue;
      }
      const targetFilePath = await resolveImportTargetInContext(importerFilePath, importStatement.from.value, context);
      if (!targetFilePath) {
        return null;
      }
      const targetSession = await getSessionForFilePath(targetFilePath, context);
      if (!targetSession?.ast) {
        return null;
      }
      const declaration = findTopLevelDeclarationByName(targetSession.ast, specifier.imported.name);
      if (!declaration) {
        return null;
      }
      const range = declarationRangeForName(declaration, specifier.imported.name);
      if (!range) {
        return null;
      }
      return {
        uri: pathToUri(targetFilePath),
        range
      };
    }
  }
  return null;
}
