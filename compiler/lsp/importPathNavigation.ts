import { ExportStatement, ExprStatement, Identifier, ImportStatement } from "compiler/ast/ast";
import type { Program } from "compiler/ast/ast";
import { resolveNodeModulesTypingsPath } from "compiler/moduleResolution";

import type { Hover, Location } from "vscode-languageserver/node.js";
import { pathToUri, uriToFilePath } from "./importFixes";
import { nodeRange } from "./ranges";
import {
  declarationRangeForName,
  findImportBindingByLocalName,
  findImportStringLiteralAtPosition,
  getSessionForFilePath,
  importStatementBindings,
  resolveImportTargetInContext,
  type ImportBinding,
  type ResolveContext
} from "./crossFileContext";
import { topLevelDeclarationNames } from "./declarationResolver";
import { parseDtsProgram, resolveRelativeDtsPath } from "./dtsModuleGraph";

function moduleStartLocation(filePath: string): Location {
  return {
    uri: pathToUri(filePath),
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
  };
}

async function resolveImportedFilePath(
  importerFilePath: string,
  specifier: string,
  context: ResolveContext
): Promise<string | null> {
  if (specifier.startsWith(".")) {
    return await resolveRelativeDtsPath(importerFilePath, specifier, { vfs: context.vfs })
      ?? await resolveImportTargetInContext(importerFilePath, specifier, context);
  }
  return await resolveImportTargetInContext(importerFilePath, specifier, context)
    ?? await resolveNodeModulesTypingsPath(importerFilePath, specifier, { vfs: context.vfs });
}

async function navigationProgram(filePath: string, context: ResolveContext): Promise<Program | null> {
  const session = await getSessionForFilePath(filePath, context);
  if (session?.ast) {
    return session.ast;
  }
  return parseDtsProgram(filePath, { vfs: context.vfs });
}

function directDeclarationLocation(
  ast: Program,
  filePath: string,
  name: string
): Location | null {
  for (const statement of ast.body) {
    const declaration = statement instanceof ExportStatement
      ? (statement as ExportStatement).declaration
      : statement instanceof ImportStatement
        ? undefined
        : statement;
    if (!declaration || !topLevelDeclarationNames(declaration).includes(name)) {
      continue;
    }
    const range = declarationRangeForName(declaration, name) ?? nodeRange(declaration);
    if (range) {
      return { uri: pathToUri(filePath), range };
    }
  }
  return null;
}

async function resolveExportedSymbolDefinitionImpl(
  context: ResolveContext,
  filePath: string,
  exportName: string,
  visited: Set<string>
): Promise<Location | null> {
  const visitKey = `${filePath}\0${exportName}`;
  if (visited.has(visitKey)) {
    return null;
  }
  visited.add(visitKey);

  const ast = await navigationProgram(filePath, context);
  if (!ast) {
    return null;
  }

  for (const originalStatement of ast.body) {
    if (!(originalStatement instanceof ExportStatement)) {
      continue;
    }
    const statement = originalStatement as ExportStatement;
    if (statement.declaration && topLevelDeclarationNames(statement.declaration).includes(exportName)) {
      const range = declarationRangeForName(statement.declaration, exportName) ?? nodeRange(statement.declaration);
      if (range) {
        return { uri: pathToUri(filePath), range };
      }
    }

    if (exportName === "default" && statement.isDefault && statement.declaration) {
      const expression = statement.declaration instanceof ExprStatement
        ? (statement.declaration as ExprStatement).expression
        : null;
      if (expression instanceof Identifier) {
        const localName = (expression as Identifier).name;
        const localImport = findImportBindingByLocalName(ast.body, localName);
        if (localImport) {
          const imported = await resolveImportBindingDefinitionImpl(
            context,
            filePath,
            localImport,
            visited
          );
          if (imported) return imported;
        }
        const localDeclaration = directDeclarationLocation(ast, filePath, localName);
        if (localDeclaration) return localDeclaration;
      }
      const range = nodeRange(statement.declaration);
      if (range) return { uri: pathToUri(filePath), range };
    }

    if (statement.namespaceExport?.name === exportName && statement.from?.value) {
      const targetFilePath = await resolveImportedFilePath(filePath, statement.from.value, context);
      if (targetFilePath) return moduleStartLocation(targetFilePath);
    }

    const matchingSpecifier = statement.specifiers?.find(
      (specifier) => specifier.exported.name === exportName
    );
    if (matchingSpecifier) {
      const localName = matchingSpecifier.local?.name ?? matchingSpecifier.exported.name;
      if (statement.from?.value) {
        const targetFilePath = await resolveImportedFilePath(filePath, statement.from.value, context);
        if (targetFilePath) {
          const reexported = await resolveExportedSymbolDefinitionImpl(
            context,
            targetFilePath,
            localName,
            visited
          );
          if (reexported) return reexported;
        }
      } else {
        const localImport = findImportBindingByLocalName(ast.body, localName);
        if (localImport) {
          const imported = await resolveImportBindingDefinitionImpl(
            context,
            filePath,
            localImport,
            visited
          );
          if (imported) return imported;
        }
        const localDeclaration = directDeclarationLocation(ast, filePath, localName);
        if (localDeclaration) return localDeclaration;
      }
      const range = nodeRange(matchingSpecifier.local ?? matchingSpecifier.exported);
      if (range) return { uri: pathToUri(filePath), range };
    }

  }

  // Named and direct exports take precedence over export-star fallbacks. Apart
  // from matching JavaScript semantics, this avoids walking a package's entire
  // declaration graph when its entry point explicitly forwards the symbol.
  for (const originalStatement of ast.body) {
    if (!(originalStatement instanceof ExportStatement)) {
      continue;
    }
    const statement = originalStatement as ExportStatement;
    if (!statement.exportAll || !statement.from?.value || exportName === "default") {
      continue;
    }
    const targetFilePath = await resolveImportedFilePath(filePath, statement.from.value, context);
    if (targetFilePath) {
      const reexported = await resolveExportedSymbolDefinitionImpl(
        context,
        targetFilePath,
        exportName,
        visited
      );
      if (reexported) return reexported;
    }
  }

  return directDeclarationLocation(ast, filePath, exportName);
}

async function resolveImportBindingDefinitionImpl(
  context: ResolveContext,
  importerFilePath: string,
  binding: ImportBinding,
  visited: Set<string>
): Promise<Location | null> {
  const targetFilePath = await resolveImportedFilePath(importerFilePath, binding.from, context);
  if (!targetFilePath) {
    return null;
  }
  if (binding.kind === "namespace") {
    return moduleStartLocation(targetFilePath);
  }
  return resolveExportedSymbolDefinitionImpl(
    context,
    targetFilePath,
    binding.kind === "default" ? "default" : binding.importedName,
    visited
  );
}

export async function resolveImportBindingDefinition(
  context: ResolveContext,
  importerFilePath: string,
  binding: ImportBinding
): Promise<Location | null> {
  return resolveImportBindingDefinitionImpl(context, importerFilePath, binding, new Set<string>());
}

export async function resolveExportedSymbolDefinition(
  context: ResolveContext,
  filePath: string,
  exportName: string
): Promise<Location | null> {
  return resolveExportedSymbolDefinitionImpl(context, filePath, exportName, new Set<string>());
}

function identifierContainsPosition(identifier: Identifier, line: number, character: number): boolean {
  const first = identifier.firstToken;
  const last = identifier.lastToken;
  if (!first || !last) return false;
  return (
    (line > first.range.start.line || (line === first.range.start.line && character >= first.range.start.column))
    && (line < last.range.end.line || (line === last.range.end.line && character <= last.range.end.column))
  );
}

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
    for (const binding of importStatementBindings(importStatement)) {
      if (
        !identifierContainsPosition(binding.localNode, context.line, context.character)
        && !identifierContainsPosition(binding.importedNode, context.line, context.character)
      ) {
        continue;
      }
      return resolveImportBindingDefinition(context, importerFilePath, binding);
    }
  }
  return null;
}
