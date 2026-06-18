/**
 * Shared cross-file navigation context: resolve-context/session contracts,
 * import-target resolution, canonical top-level symbol resolution, and the
 * local (same-file) reference/rename fallbacks used by every cross-file
 * navigation operation.
 */
import type { Location, Range, WorkspaceEdit } from "vscode-languageserver/node.js";
import { findTopLevelDeclarationInProgram, topLevelDeclarationNames } from "./declarationResolver";
import { uriToFilePath } from "./importFixes";
import { getProjectIndex, getProjectSessionForFilePath } from "./projectAnalysis";
import { findNodeModuleExportLocation } from "./nodeModulesTypings";
import { containsPosition, nodeRange } from "./ranges";
import { createReferences, createRenameWorkspaceEdit } from "./navigation";
import type { Analysis } from "compiler/analysis/Analysis";
import type { AnnotationStatement, ArrowFunctionExpression, BlockStatement, CallExpression, ClassStatement, ExprStatement, ExportStatement, FunctionStatement, Identifier, ImportStatement, InterfaceStatement, NamespaceStatement, Program, Statement, VarStatement } from "compiler/ast/ast";
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
  externalDeclarations?: Statement[];
  ambientDeclarations?: Statement[];
  ambientDeclarationLocations?: ReadonlyMap<Statement, { filePath: string; line: number; character: number }>;
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

export function findModuleReceiverImport(
  ast: Program,
  receiverName: string
): { from: string } | null {
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const defaultImport = importStatement.defaultImport as Identifier | undefined;
    const namespaceImport = importStatement.namespaceImport as Identifier | undefined;
    const matchesDefault = defaultImport?.kind === "Identifier" && defaultImport.name === receiverName;
    const matchesNamespace = namespaceImport?.kind === "Identifier" && namespaceImport.name === receiverName;
    if (matchesDefault || matchesNamespace) {
      return { from: importStatement.from.value };
    }
  }
  return null;
}

/**
 * Finds the import statement whose default or namespace binding matches
 * `receiverName` (e.g. `import path from "node:path"` bound as `path` in
 * `path.join(...)`), and returns the ambient module-name candidates to look
 * up declarations under (the import path itself, plus the `node:`-stripped
 * form for Node builtin modules). Shared by definition navigation and
 * signature help when resolving a member/call on a default-imported module
 * object.
 */
export function findAmbientModuleReceiverCandidates(
  ast: Program,
  receiverName: string
): string[] | null {
  const receiverImport = findModuleReceiverImport(ast, receiverName);
  if (receiverImport) {
    const moduleCandidates = [receiverImport.from];
    if (receiverImport.from.startsWith("node:")) {
      moduleCandidates.push(receiverImport.from.slice("node:".length));
    }
    return moduleCandidates;
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

export function ambientDeclarationLocationForSymbol(
  session: SessionLike,
  symbolNode: unknown,
  symbolName: string
): CanonicalSymbol | null {
  const ambientDeclarations = session.ambientDeclarations ?? [];
  const ambientDeclarationLocations = session.ambientDeclarationLocations;
  if (!ambientDeclarationLocations) {
    return null;
  }
  for (const declaration of ambientDeclarations) {
    if (!declarationDeclaresNode(declaration, symbolNode)) {
      continue;
    }
    const location = ambientDeclarationLocations.get(declaration);
    const range = declarationRangeForName(declaration, symbolName);
    if (!location || !range) {
      continue;
    }
    return {
      name: symbolName,
      filePath: location.filePath,
      range
    };
  }
  return null;
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
      const ambientLocation = ambientDeclarationLocationForSymbol(
        context.session,
        symbolAt.symbol.node,
        symbolAt.symbol.name
      );
      if (ambientLocation) {
        return {
          ...ambientLocation,
          filePath: await preferVirtualRuntimeDeclarationFilePath(ambientLocation.filePath, context)
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
    const nodeModuleLocation = await findNodeModuleExportLocation(
      currentFilePath,
      importBinding.from,
      importBinding.name,
      { vfs: context.vfs }
    );
    if (nodeModuleLocation) {
      return {
        name: importBinding.name,
        filePath: nodeModuleLocation.typingsPath,
        range: nodeModuleLocation.range
      };
    }
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

/**
 * Scans ambient module declarations for an `export = name` pattern (represented
 * as an ExprStatement whose expression is an Identifier) and returns the
 * identifier name. Used by both cross-file navigation and signature help to
 * follow the ambient module's export alias.
 */
export function detectAmbientExportEqualsName(declarations: readonly Statement[]): string | null {
  for (const statement of declarations) {
    if (statement.kind !== "ExprStatement") {
      continue;
    }
    const expression = (statement as ExprStatement).expression;
    if (expression?.kind === "Identifier") {
      return (expression as Identifier).name;
    }
  }
  return null;
}

/**
 * Scans ambient module declarations for a NamespaceStatement with the given
 * name and returns its body statements. Used by both cross-file navigation and
 * signature help to look up members within an ambient namespace.
 */
export function findAmbientNamespaceBody(
  declarations: readonly Statement[],
  namespaceName: string
): Statement[] | null {
  for (const statement of declarations) {
    const candidate =
      statement.kind === "ExportStatement"
        ? (statement as ExportStatement).declaration ?? statement
        : statement;
    if (candidate.kind !== "NamespaceStatement") {
      continue;
    }
    const namespaceStatement = candidate as NamespaceStatement;
    if (namespaceStatement.names?.[0]?.name === namespaceName) {
      return namespaceStatement.body.body;
    }
  }
  return null;
}

/**
 * Looks up a named export within ambient module declarations, covering:
 * 1. Direct top-level declaration by name.
 * 2. `export = Alias` pattern — follows the alias to a namespace body and finds
 *    the name there as a direct declaration.
 * 3. `export = Alias` pattern — follows the alias to a namespace body, finds a
 *    variable typed as an interface, and resolves the name as an interface member.
 * 4. `global {}` blocks — if no match was found above, also searches inside any
 *    `global { ... }` block for a direct declaration. In the AST, this syntax is
 *    parsed as an ExprStatement whose expression is a CallExpression with callee
 *    `"global"` and a single ArrowFunctionExpression body. Note: when ambient
 *    types are loaded via `ambientTypesLoader.ts`, `global {}` content inside
 *    `declare module` blocks is already flattened into the global declarations
 *    list, so this branch primarily helps declarations assembled directly
 *    (e.g. in editor virtual workspaces or unit tests).
 *
 * Returns the name-identifier range of the matching declaration, or `null`.
 */
export function findAmbientNamedExportRange(
  declarations: readonly Statement[],
  exportedName: string
): Range | null {
  // 1. Direct declaration by name.
  const directDeclaration =
    declarations.find(
      (statement) => topLevelDeclarationNames(statement).includes(exportedName)
    ) ?? null;
  const directRange = directDeclaration
    ? declarationRangeForName(directDeclaration, exportedName)
    : null;
  if (directRange) {
    return directRange;
  }

  // 2 & 3. Follow the export = alias into a namespace body.
  const exportEqualsName = detectAmbientExportEqualsName(declarations);
  if (exportEqualsName) {
    const exportNamespaceBody = findAmbientNamespaceBody(declarations, exportEqualsName);

    // 2. Direct declaration inside the namespace body.
    const namespaceDirectDeclaration = exportNamespaceBody
      ? (exportNamespaceBody.find(
          (statement) => topLevelDeclarationNames(statement).includes(exportedName)
        ) ?? null)
      : null;
    const namespaceDirectRange = namespaceDirectDeclaration
      ? declarationRangeForName(namespaceDirectDeclaration, exportedName)
      : null;
    if (namespaceDirectRange) {
      return namespaceDirectRange;
    }

    // 3. Variable typed as an interface — find the member in that interface.
    for (const statement of declarations) {
      const candidate =
        statement.kind === "ExportStatement"
          ? (statement as ExportStatement).declaration ?? statement
          : statement;
      if (candidate.kind !== "VarStatement") {
        continue;
      }
      const variableStatement = candidate as VarStatement;
      const variableName =
        variableStatement.name.kind === "Identifier" ? variableStatement.name.name : null;
      const typeName = variableStatement.typeAnnotation?.name;
      if (variableName !== exportEqualsName || !typeName) {
        continue;
      }
      const separator = typeName.lastIndexOf(".");
      const namespaceName = separator > 0 ? typeName.slice(0, separator) : null;
      const interfaceName = separator > 0 ? typeName.slice(separator + 1) : typeName;
      const searchDeclarations = namespaceName
        ? findAmbientNamespaceBody(declarations, namespaceName)
        : declarations;
      if (!searchDeclarations) {
        continue;
      }
      for (const decl of searchDeclarations) {
        const declCandidate =
          decl.kind === "ExportStatement"
            ? (decl as ExportStatement).declaration ?? decl
            : decl;
        if (declCandidate.kind !== "InterfaceStatement") {
          continue;
        }
        const interfaceStatement = declCandidate as InterfaceStatement;
        if (interfaceStatement.name.name !== interfaceName) {
          continue;
        }
        const member = interfaceStatement.members.find(
          (item) => item.name.name === exportedName
        );
        if (member) {
          return nodeRange(member.name);
        }
      }
    }
  }

  // 4. Search inside any `global {}` block in the declarations.
  // In the AST, `global { ... }` inside a module body is parsed as an
  // ExprStatement wrapping a CallExpression with callee named "global" and a
  // single ArrowFunctionExpression argument whose body is a BlockStatement.
  // This handles cases where the declarations were not pre-flattened by
  // ambientTypesLoader (which extracts global block content into globalDeclarations).
  for (const statement of declarations) {
    if (statement.kind !== "ExprStatement") {
      continue;
    }
    const expression = (statement as ExprStatement).expression;
    if (expression?.kind !== "CallExpression") {
      continue;
    }
    const call = expression as CallExpression;
    if (call.callee.kind !== "Identifier") {
      continue;
    }
    const calleeIdentifier = call.callee as unknown as { name: string };
    if (calleeIdentifier.name !== "global") {
      continue;
    }
    const arg = call.arguments[0];
    if (arg?.kind !== "ArrowFunctionExpression") {
      continue;
    }
    const block = (arg as ArrowFunctionExpression).body;
    if (block.kind !== "BlockStatement") {
      continue;
    }
    const globalBodyStatements = (block as BlockStatement).body;
    const globalDirectDeclaration =
      globalBodyStatements.find(
        (s) => topLevelDeclarationNames(s).includes(exportedName)
      ) ?? null;
    if (globalDirectDeclaration) {
      return declarationRangeForName(globalDirectDeclaration, exportedName);
    }
  }

  return null;
}

/**
 * Collects all FunctionStatement nodes in `statements` whose declared name
 * matches `name`. Unwraps ExportStatement wrappers so that both bare and
 * exported declarations are found.
 *
 * Used by both `crossFileNavigation.ts` (for overload-range selection when
 * navigating to a definition) and `signatureHelp.ts` (for building
 * SignatureInformation from ambient overloads). The callers map the returned
 * statements differently, so only the raw AST nodes are returned here.
 */
export function collectAmbientFunctionStatements(
  statements: readonly Statement[],
  name: string
): FunctionStatement[] {
  const matches: FunctionStatement[] = [];
  for (const statement of statements) {
    const candidate =
      statement.kind === "ExportStatement"
        ? (statement as ExportStatement).declaration ?? statement
        : statement;
    if (candidate.kind !== "FunctionStatement") {
      continue;
    }
    const fn = candidate as FunctionStatement;
    if (fn.name.name === name) {
      matches.push(fn);
    }
  }
  return matches;
}
