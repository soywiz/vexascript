import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Analysis } from "compiler/analysis/Analysis";
import { candidateImportTargetFilePaths, resolveImportTargetFilePath, resolveNodeModulesTypingsPath } from "compiler/moduleResolution";
import {
  findMatchingTypeDelimiter,
  findTopLevelTypeCharacter,
  splitTopLevelDelimitedTypeText
} from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
import {
  getEcmaScriptRuntimeDeclarationFilePath,
  isEcmaScriptRuntimeNode
} from "compiler/runtime/ecmascriptDeclarations";
import { getDomDeclarationFilePath, isDomRuntimeNode } from "compiler/runtime/domDeclarations";
import type {
  ArrayLiteral,
  ArrowFunctionExpression,
  AsExpression,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  FunctionExpression,
  Expr,
  ClassStatement,
  InterfaceStatement,
  ConditionalExpression,
  CommaExpression,
  DoWhileStatement,
  ExprStatement,
  ExportStatement,
  ForStatement,
  FunctionStatement,
  FunctionParameter,
  Identifier,
  IfStatement,
  LabeledStatement,
  ImportStatement,
  MemberExpression,
  NewExpression,
  NonNullExpression,
  ObjectLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
  Statement,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  TypeAliasStatement,
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement,
  WithStatement
} from "compiler/ast/ast";
import { bindingIdentifiers, bindingNameText } from "compiler/ast/bindingPatterns";
import {
  findTopLevelDeclarationInProgram,
  resolveTopLevelDeclarationAcrossFiles,
  topLevelDeclarationNames
} from "./declarationResolver";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import type { Hover, Location, WorkspaceEdit } from "vscode-languageserver/node.js";
import { pathToUri, uriToFilePath } from "./importFixes";
import { containsPosition, nodeRange } from "./ranges";
import {
  classPropertyParameters,
  createClassResolverCache,
  resolveClassMember,
  resolveInterfaceMember,
  resolveInterfaceMemberDeclaration,
} from "./classResolver";
import {
  getProjectIndex,
  getProjectSessionForFilePath,
  scanProjectMyFiles
} from "./projectAnalysis";
import { findNodeModuleMemberLocation } from "./nodeModulesTypings";

function boxedNavigationTypeName(typeName: string): string {
  if (typeName === "int" || typeName === "number" || typeName === "numeric") {
    return "Number";
  }
  if (typeName === "string") {
    return "String";
  }
  if (typeName === "boolean") {
    return "Boolean";
  }
  if (typeName === "bigint" || typeName === "long") {
    return "BigInt";
  }
  return typeName;
}

interface SessionLike {
  ast: Program | null;
  analysis: Analysis | null;
}

interface ResolveContext {
  uri: string;
  line: number;
  character: number;
  session: SessionLike;
  sourceRoots: string[];
  vfs?: import("compiler/vfs").Vfs;
  getSessionForFilePath?: (filePath: string) => SessionLike | null | Promise<SessionLike | null>;
}

interface CanonicalSymbol {
  name: string;
  filePath: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface CanonicalMemberSymbol {
  className: string;
  memberName: string;
  filePath: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface ClassMemberInfo {
  memberName: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  typeLabel: string;
  sourceKind: "primary-constructor" | "field" | "method";
}

type TypeLikeDeclaration = ClassStatement | InterfaceStatement;

interface ObjectTypeMemberInfo {
  memberName: string;
  typeLabel: string;
  kind: "field" | "method";
}
const TYPE_ANNOTATION_KEYS = new Set([
  "typeAnnotation",
  "returnType",
  "extendsType",
  "extendsTypes",
  "implementsTypes",
  "receiverType",
  "typeArguments",
  "constraint",
  "defaultType"
]);

function localReferencesFromContext(
  context: ResolveContext,
  includeDeclaration: boolean
): Location[] {
  if (!context.session.analysis) {
    return [];
  }
  const ranges = context.session.analysis.getReferenceRangesAt(
    context.line,
    context.character,
    includeDeclaration
  );
  return ranges.map((range) => ({
    uri: context.uri,
    range
  }));
}

function localRenameWorkspaceEdit(context: ResolveContext, newName: string): WorkspaceEdit | null {
  if (!context.session.analysis) {
    return null;
  }
  const ranges = context.session.analysis.getRenameRangesAt(
    context.line,
    context.character
  );
  if (ranges.length === 0) {
    return null;
  }
  return {
    changes: {
      [context.uri]: ranges.map((range) => ({
        range,
        newText: newName
      }))
    }
  };
}


function findImportForSymbolNode(ast: Program, symbolNode: unknown): { from: string; name: string } | null {
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

function findTopLevelDeclarationByName(ast: Program, name: string): Statement | null {
  return findTopLevelDeclarationInProgram(
    ast,
    name,
    (statement): statement is Statement => topLevelDeclarationNames(statement).includes(name)
  );
}

function declarationRangeForName(statement: Statement, name: string) {
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
  if (statement.kind === "InterfaceStatement") {
    return nodeRange((statement as InterfaceStatement).name);
  }
  if (statement.kind === "FunctionStatement") {
    return nodeRange((statement as FunctionStatement).name);
  }
  return nodeRange(statement);
}

async function getSessionForFilePath(filePath: string, context: ResolveContext): Promise<SessionLike | null> {
  return getProjectSessionForFilePath(filePath, {
    sourceRoots: context.sourceRoots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });
}

async function resolveImportTargetInContext(
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
function declarationDeclaresNode(declaration: Statement, symbolNode: unknown): boolean {
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
async function resolveExternalDeclarationLocation(
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

async function resolveCanonicalSymbol(context: ResolveContext): Promise<CanonicalSymbol | null> {
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
      return {
        name: symbolAt.symbol.name,
        filePath: await getEcmaScriptRuntimeDeclarationFilePath(),
        range: definition.range
      };
    }
    if (isDomRuntimeNode(symbolAt.symbol.node)) {
      return {
        name: symbolAt.symbol.name,
        filePath: getDomDeclarationFilePath(),
        range: definition.range
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

function rangesEqual(
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

async function findMatchingImportSpecifierPositions(
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


function classMemberDeclarationRangeByName(
  classStatement: TypeLikeDeclaration,
  memberName: string
): { start: { line: number; character: number }; end: { line: number; character: number } } | null {
  if (classStatement.kind === "InterfaceStatement") {
    for (const member of classStatement.members) {
      if (member.name.name !== memberName) {
        continue;
      }
      const range = nodeRange(member.name);
      if (range) {
        return range;
      }
    }
    return null;
  }

  for (const parameter of classPropertyParameters(classStatement)) {
    if (bindingNameText(parameter.name) !== memberName) {
      continue;
    }
    const range = nodeRange(parameter.name);
    if (range) {
      return range;
    }
  }

  for (const member of classStatement.members) {
    if (member.name.name !== memberName) {
      continue;
    }
    const range = nodeRange(member.name);
    if (range) {
      return range;
    }
  }

  return null;
}

async function fallbackInterfaceMemberRangeInFile(
  filePath: string,
  interfaceName: string,
  memberName: string
): Promise<{ start: { line: number; character: number }; end: { line: number; character: number } } | null> {
  const source = await readFile(filePath, "utf8");
  const lines = source.split("\n");
  const interfacePattern = new RegExp(`\\binterface\\s+${interfaceName}\\b`);
  const memberPattern = new RegExp(`\\b${memberName}\\b`);

  let interfaceLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (interfacePattern.test(lines[i] ?? "")) {
      interfaceLine = i;
      break;
    }
  }
  if (interfaceLine < 0) {
    return null;
  }

  let braceDepth = 0;
  let enteredBody = false;
  for (let i = interfaceLine; i < lines.length; i += 1) {
    const lineText = lines[i] ?? "";
    for (const char of lineText) {
      if (char === "{") {
        braceDepth += 1;
        enteredBody = true;
      } else if (char === "}") {
        braceDepth -= 1;
      }
    }
    if (enteredBody && braceDepth <= 0) {
      break;
    }
    const match = memberPattern.exec(lineText);
    if (!match) {
      continue;
    }
    return {
      start: { line: i, character: match.index },
      end: { line: i, character: match.index + memberName.length }
    };
  }

  return null;
}

async function fallbackTypeAliasMemberRangeInFile(
  filePath: string,
  typeAliasName: string,
  memberName: string
): Promise<{ start: { line: number; character: number }; end: { line: number; character: number } } | null> {
  const source = await readFile(filePath, "utf8");
  const lines = source.split("\n");
  const typePattern = new RegExp(`\\btype\\s+${typeAliasName}\\b`);
  const memberPattern = new RegExp(`\\b${memberName}\\b`);

  let typeLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (typePattern.test(lines[i] ?? "")) {
      typeLine = i;
      break;
    }
  }
  if (typeLine < 0) {
    return null;
  }

  let braceDepth = 0;
  let enteredBody = false;
  for (let i = typeLine; i < lines.length; i += 1) {
    const lineText = lines[i] ?? "";
    for (const char of lineText) {
      if (char === "{") {
        braceDepth += 1;
        enteredBody = true;
      } else if (char === "}") {
        braceDepth -= 1;
      }
    }
    if (enteredBody && braceDepth <= 0) {
      break;
    }
    const match = memberPattern.exec(lineText);
    if (!match) {
      continue;
    }
    return {
      start: { line: i, character: match.index },
      end: { line: i, character: match.index + memberName.length }
    };
  }

  return null;
}

function functionTypeLabelFromParameters(
  parameters: FunctionParameter[],
  returnTypeName?: string
): string {
  const parameterLabel = parameters
    .map((parameter) => {
      const typeName = parameter.typeAnnotation?.name ?? "unknown";
      const optionalSuffix = parameter.optional ? "?" : "";
      return `${bindingNameText(parameter.name)}${optionalSuffix}: ${typeName}`;
    })
    .join(", ");
  return `(${parameterLabel}) => ${returnTypeName ?? "void"}`;
}

function classMemberInfoByName(
  classStatement: TypeLikeDeclaration,
  memberName: string
): ClassMemberInfo | null {
  if (classStatement.kind === "InterfaceStatement") {
    for (const member of classStatement.members) {
      if (member.name.name !== memberName) {
        continue;
      }
      const range = nodeRange(member.name);
      if (!range) {
        return null;
      }
      if (member.kind === "InterfacePropertyMember") {
        return {
          memberName,
          range,
          typeLabel: member.typeAnnotation.name,
          sourceKind: "field"
        };
      }
      return {
        memberName,
        range,
        typeLabel: functionTypeLabelFromParameters(member.parameters, member.returnType?.name),
        sourceKind: "method"
      };
    }
    return null;
  }

  for (const parameter of classPropertyParameters(classStatement)) {
    if (bindingNameText(parameter.name) !== memberName) {
      continue;
    }
    const range = nodeRange(parameter.name);
    if (!range) {
      return null;
    }
    return {
      memberName,
      range,
      typeLabel: parameter.typeAnnotation?.name ?? "unknown",
      sourceKind: "primary-constructor"
    };
  }

  for (const member of classStatement.members) {
    if (member.name.name !== memberName) {
      continue;
    }
    const range = nodeRange(member.name);
    if (!range) {
      return null;
    }
    if (member.kind === "ClassFieldMember") {
      return {
        memberName,
        range,
        typeLabel: member.typeAnnotation?.name ?? "unknown",
        sourceKind: "field"
      };
    }
    return {
      memberName,
      range,
      typeLabel: functionTypeLabelFromParameters(member.parameters, member.returnType?.name),
      sourceKind: "method"
    };
  }

  return null;
}

function parseObjectTypeMemberInfo(
  objectTypeText: string,
  memberName: string
): ObjectTypeMemberInfo | null {
  const targetTypeText = objectTypeText.trim();
  if (!targetTypeText.startsWith("{") || !targetTypeText.endsWith("}")) {
    return null;
  }

  const body = targetTypeText.slice(1, -1).trim();
  if (body.length === 0) {
    return null;
  }

  for (const entry of splitTopLevelDelimitedTypeText(body, new Set([",", ";"]))) {
    const trimmedEntry = entry.trim();
    if (trimmedEntry.length === 0) {
      continue;
    }

    const methodOpenParen = findTopLevelTypeCharacter(trimmedEntry, "(");
    const propertyColon = findTopLevelTypeCharacter(trimmedEntry, ":");
    if (methodOpenParen >= 0 && (propertyColon < 0 || methodOpenParen < propertyColon)) {
      const closeParen = findMatchingTypeDelimiter(trimmedEntry, methodOpenParen, "(", ")");
      const arrowIndex = closeParen >= 0 ? trimmedEntry.indexOf("=>", closeParen) : -1;
      if (closeParen < 0 || arrowIndex < 0) {
        continue;
      }
      const candidateName = trimmedEntry.slice(0, methodOpenParen).trim().replace(/\?$/, "");
      if (candidateName !== memberName) {
        continue;
      }
      return {
        memberName,
        kind: "method",
        typeLabel: trimmedEntry.slice(methodOpenParen).trim()
      };
    }

    if (propertyColon < 0) {
      continue;
    }
    const candidateName = trimmedEntry.slice(0, propertyColon).trim().replace(/\?$/, "");
    if (candidateName !== memberName) {
      continue;
    }
    return {
      memberName,
      kind: "field",
      typeLabel: trimmedEntry.slice(propertyColon + 1).trim()
    };
  }

  return null;
}

async function resolveTypeDefinitionAcrossFiles(
  context: ResolveContext,
  typeName: string
): Promise<{ declaration: TypeLikeDeclaration; filePath: string } | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  const roots = context.sourceRoots.length > 0 ? context.sourceRoots : [dirname(currentFilePath)];
  const resolved = await resolveTopLevelDeclarationAcrossFiles({
    ast: context.session.ast,
    name: typeName,
    currentFilePath,
    predicate: (statement): statement is TypeLikeDeclaration =>
      statement.kind === "ClassStatement" || statement.kind === "InterfaceStatement",
    includeRuntime: true,
    sourceRoots: roots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });

  if (!resolved) {
    return null;
  }

  return {
    declaration: resolved.declaration,
    filePath: resolved.filePath === "" ? await getEcmaScriptRuntimeDeclarationFilePath() : resolved.filePath
  };
}

async function resolveTypeAliasDefinitionAcrossFiles(
  context: ResolveContext,
  typeName: string
): Promise<{ declaration: TypeAliasStatement; filePath: string } | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  const roots = context.sourceRoots.length > 0 ? context.sourceRoots : [dirname(currentFilePath)];
  const resolved = await resolveTopLevelDeclarationAcrossFiles({
    ast: context.session.ast,
    name: typeName,
    currentFilePath,
    predicate: (statement): statement is TypeAliasStatement => statement.kind === "TypeAliasStatement",
    includeRuntime: true,
    sourceRoots: roots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });

  if (!resolved) {
    return null;
  }

  return {
    declaration: resolved.declaration,
    filePath: resolved.filePath === "" ? await getEcmaScriptRuntimeDeclarationFilePath() : resolved.filePath
  };
}

function isAstNode(value: unknown): value is { kind: string } {
  return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}

function findTypeIdentifierAtPosition(
  value: unknown,
  line: number,
  character: number
): Identifier | null {
  let best: Identifier | null = null;
  let bestSize = Number.POSITIVE_INFINITY;

  const considerIdentifier = (identifier: Identifier): void => {
    const range = nodeRange(identifier);
    if (!range || !containsPosition(range, { line, character })) {
      return;
    }
    const size =
      (range.end.line - range.start.line) * 100_000 +
      (range.end.character - range.start.character);
    if (size <= bestSize) {
      best = identifier;
      bestSize = size;
    }
  };

  const visitTypeValue = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        visitTypeValue(item);
      }
      return;
    }
    if (!isAstNode(entry)) {
      return;
    }
    if (entry.kind === "Identifier") {
      considerIdentifier(entry as Identifier);
    }
    for (const [key, child] of Object.entries(entry)) {
      if (key === "kind" || key === "range" || key === "firstToken" || key === "lastToken") {
        continue;
      }
      visitTypeValue(child);
    }
  };

  const visitNode = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        visitNode(item);
      }
      return;
    }
    if (!isAstNode(entry)) {
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      if (TYPE_ANNOTATION_KEYS.has(key)) {
        visitTypeValue(child);
        continue;
      }
      if (key === "kind" || key === "range" || key === "firstToken" || key === "lastToken") {
        continue;
      }
      visitNode(child);
    }
  };

  visitNode(value);
  return best;
}

function findMemberExpressionAtPosition(
  program: Program,
  line: number,
  character: number
): MemberExpression | null {
  let best: { member: MemberExpression; size: number } | null = null;

  const consider = (member: MemberExpression): void => {
    if (member.computed || member.property.kind !== "Identifier") {
      return;
    }
    const propertyRange = nodeRange(member.property);
    if (!propertyRange || !containsPosition(propertyRange, { line, character })) {
      return;
    }
    const size =
      (propertyRange.end.line - propertyRange.start.line) * 100_000 +
      (propertyRange.end.character - propertyRange.start.character);
    if (!best || size <= best.size) {
      best = { member, size };
    }
  };

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "MemberExpression": {
        const member = expression as MemberExpression;
        consider(member);
        visitExpression(member.object);
        if (member.computed) {
          visitExpression(member.property);
        }
        return;
      }
      case "CallExpression":
        for (const argument of (expression as CallExpression).arguments) {
          visitExpression(argument);
        }
        visitExpression((expression as CallExpression).callee);
        return;
      case "NewExpression":
        visitExpression((expression as NewExpression).callee);
        for (const argument of (expression as NewExpression).arguments ?? []) {
          visitExpression(argument);
        }
        return;
      case "CommaExpression":
        for (const child of (expression as CommaExpression).expressions) {
          visitExpression(child);
        }
        return;
      case "AsExpression":
        visitExpression((expression as AsExpression).expression);
        return;
      case "NonNullExpression":
        visitExpression((expression as NonNullExpression).expression);
        return;
      case "BinaryExpression":
        visitExpression((expression as BinaryExpression).left);
        visitExpression((expression as BinaryExpression).right);
        return;
      case "RangeExpression":
        visitExpression((expression as RangeExpression).start);
        visitExpression((expression as RangeExpression).end);
        return;
      case "AssignmentExpression":
        visitExpression((expression as AssignmentExpression).left);
        visitExpression((expression as AssignmentExpression).right);
        return;
      case "ConditionalExpression":
        visitExpression((expression as ConditionalExpression).test);
        visitExpression((expression as ConditionalExpression).consequent);
        visitExpression((expression as ConditionalExpression).alternate);
        return;
      case "UnaryExpression":
        visitExpression((expression as UnaryExpression).argument);
        return;
      case "UpdateExpression":
        visitExpression((expression as UpdateExpression).argument);
        return;
      case "ArrayLiteral":
        for (const element of (expression as ArrayLiteral).elements) {
          visitExpression(element);
        }
        return;
      case "ObjectLiteral":
        for (const property of (expression as ObjectLiteral).properties) {
          if (property.kind === "ObjectSpreadProperty") {
            visitExpression(property.argument);
          } else {
            visitExpression(property.value);
          }
        }
        return;
      case "ArrowFunctionExpression": {
        const body = (expression as ArrowFunctionExpression).body;
        if (body.kind === "BlockStatement") {
          for (const child of (body as BlockStatement).body) {
            visitStatement(child);
          }
        } else {
          visitExpression(body as Expr);
        }
        return;
      }
      case "FunctionExpression":
        for (const child of (expression as FunctionExpression).body.body) {
          visitStatement(child);
        }
        return;
      default:
        return;
    }
  };

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "VarStatement": {
        const variableStatement = statement as VarStatement;
        if (variableStatement.declarations && variableStatement.declarations.length > 0) {
          for (const declaration of variableStatement.declarations) {
            if (declaration.initializer) {
              visitExpression(declaration.initializer);
            }
          }
        } else if (variableStatement.initializer) {
          visitExpression(variableStatement.initializer);
        }
        return;
      }
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
      case "ExportStatement":
        {
          const declaration = (statement as ExportStatement).declaration;
          if (declaration) {
            visitStatement(declaration);
          }
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
      case "WithStatement":
        visitExpression((statement as WithStatement).object);
        visitStatement((statement as WithStatement).body);
        return;
      case "LabeledStatement":
        visitStatement((statement as LabeledStatement).body);
        return;
      case "DoWhileStatement":
        visitStatement((statement as DoWhileStatement).body);
        visitExpression((statement as DoWhileStatement).condition);
        return;
      case "ForStatement": {
        const forStatement = statement as ForStatement;
        if (forStatement.initializer && forStatement.initializer.kind === "VarStatement") {
          visitStatement(forStatement.initializer);
        } else if (forStatement.initializer) {
          visitExpression(forStatement.initializer);
        }
        if (forStatement.iterator && forStatement.iterator.kind === "VarStatement") {
          visitStatement(forStatement.iterator);
        } else if (forStatement.iterator && forStatement.iterator.kind !== "Identifier") {
          visitExpression(forStatement.iterator);
        }
        if (forStatement.iterable) {
          visitExpression(forStatement.iterable);
        }
        if (forStatement.condition) {
          visitExpression(forStatement.condition);
        }
        if (forStatement.update) {
          visitExpression(forStatement.update);
        }
        visitStatement(forStatement.body);
        return;
      }
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

  for (const statement of program.body) {
    visitStatement(statement);
  }

  if (!best) {
    return null;
  }
  return (best as { member: MemberExpression }).member;
}

async function resolveMemberDefinitionAcrossFiles(context: ResolveContext): Promise<Location | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }
  const memberExpression = findMemberExpressionAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (!memberExpression || memberExpression.property.kind !== "Identifier") {
    return null;
  }

  const objectType = context.session.analysis.getExpressionTypes().get(memberExpression.object);
  if (!objectType) {
    return null;
  }

  const memberName = (memberExpression.property as Identifier).name;
  const objectTypeLabel = typeToString(objectType);
  const structuralMember = parseObjectTypeMemberInfo(objectTypeLabel, memberName);

  // Candidate receiver type names to match against, mirroring the type checker's
  // extension lookup (e.g. an `int` literal also matches extensions on `number`).
  const receiverTypeNames =
    objectType.kind === "array"
      ? ["Array"]
      : (objectType.kind === "named" || objectType.kind === "builtin") && objectType.name === "int"
        ? ["int", "number"]
        : objectType.kind === "named" || objectType.kind === "builtin"
          ? [objectType.name]
          : [];

  // A member access on a concrete class/interface may resolve to one of its own
  // members first.
  if (objectType.kind === "named" || objectType.kind === "array" || objectType.kind === "builtin") {
    const resolvedReceiverTypeName = objectType.kind === "array"
      ? receiverTypeNames[0]!
      : boxedNavigationTypeName(receiverTypeNames[0]!);
    const classResolution = await resolveTypeDefinitionAcrossFiles(context, resolvedReceiverTypeName);
    if (classResolution) {
      const resolverContext = {
        ast: context.session.ast,
        options: {
          uri: context.uri,
          sourceRoots: context.sourceRoots,
          ...(context.getSessionForFilePath
            ? { getSessionForFilePath: context.getSessionForFilePath }
            : {})
        },
        analysis: context.session.analysis,
        cache: createClassResolverCache()
      };
      const interfaceMemberDeclaration = classResolution.declaration.kind === "InterfaceStatement"
        ? await resolveInterfaceMemberDeclaration(
          { interfaceStatement: classResolution.declaration, filePath: classResolution.filePath },
          memberName,
          objectType.kind === "array" ? `Array<${typeToString(objectType.elementType)}>` : typeToString(objectType),
          resolverContext
        )
        : null;
      const memberOwner = interfaceMemberDeclaration?.declaration ?? classResolution.declaration;
      const memberFilePath = interfaceMemberDeclaration?.filePath ?? classResolution.filePath;
      const range = classMemberDeclarationRangeByName(memberOwner, memberName)
        ?? (
          memberOwner.kind === "InterfaceStatement"
            ? await fallbackInterfaceMemberRangeInFile(memberFilePath, memberOwner.name.name, memberName)
            : null
        );
      if (range) {
        return {
          uri: pathToUri(memberFilePath),
          range
        };
      }
    }

    const typeAliasResolution = await resolveTypeAliasDefinitionAcrossFiles(context, receiverTypeNames[0]!);
    if (typeAliasResolution) {
      const range = await fallbackTypeAliasMemberRangeInFile(
        typeAliasResolution.filePath,
        typeAliasResolution.declaration.name.name,
        memberName
      );
      if (range) {
        return {
          uri: pathToUri(typeAliasResolution.filePath),
          range
        };
      }
    }
  }

  if (structuralMember && objectType.kind === "named") {
    const typeAliasResolution = await resolveTypeAliasDefinitionAcrossFiles(context, objectType.name);
    if (typeAliasResolution) {
      const range = await fallbackTypeAliasMemberRangeInFile(
        typeAliasResolution.filePath,
        typeAliasResolution.declaration.name.name,
        memberName
      );
      if (range) {
        return {
          uri: pathToUri(typeAliasResolution.filePath),
          range
        };
      }
    }
  }

  if (structuralMember) {
    for (const statement of context.session.ast.body) {
      if (statement.kind !== "ImportStatement") {
        continue;
      }
      const importStatement = statement as ImportStatement;
      const targetFilePath = await resolveImportTargetInContext(
        uriToFilePath(context.uri)!,
        importStatement.from.value,
        context
      );
      if (!targetFilePath) {
        continue;
      }
      const targetSession = await getSessionForFilePath(targetFilePath, context);
      if (!targetSession?.ast) {
        continue;
      }
      for (const targetStatement of targetSession.ast.body) {
        const declaration = unwrapExportedDeclaration(targetStatement);
        if (!declaration || declaration.kind !== "TypeAliasStatement") {
          continue;
        }
        const candidateRange = await fallbackTypeAliasMemberRangeInFile(
          targetFilePath,
          (declaration as TypeAliasStatement).name.name,
          memberName
        );
        if (candidateRange) {
          return {
            uri: pathToUri(targetFilePath),
            range: candidateRange
          };
        }
      }
    }
  }

  // Otherwise the member may be an extension property/method (e.g.
  // `val number.seconds` or `fun Point.foo()`) declared at the top level of this
  // or an imported file. These are not class members, so resolve them by
  // matching the receiver type.
  for (const receiverTypeName of receiverTypeNames) {
    const extension = await resolveExtensionMemberDefinitionAcrossFiles(context, receiverTypeName, memberName);
    if (extension) {
      return extension;
    }
  }

  // Fallback: look for the member in node_modules .d.ts declarations. This
  // handles types whose namespace/interface is declared in a package's type
  // definitions rather than a local .vx file.
  const nodeModulesDefinition = await resolveNodeModulesMemberDefinition(
    context,
    receiverTypeNames[0]!,
    memberName
  );
  if (nodeModulesDefinition) {
    return nodeModulesDefinition;
  }

  return null;
}

/**
 * Searches node_modules .d.ts files (reachable via bare-specifier imports in
 * the current file) for a member named `memberName` on a type named `typeName`.
 * Returns the location within the .d.ts file if found.
 */
async function resolveNodeModulesMemberDefinition(
  context: ResolveContext,
  typeName: string,
  memberName: string
): Promise<Location | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) return null;

  for (const stmt of context.session.ast.body) {
    if (stmt.kind !== "ImportStatement") continue;
    const importStmt = stmt as ImportStatement;
    const from = importStmt.from.value;
    if (from.startsWith(".") || from.startsWith("/")) continue;

    const location = await findNodeModuleMemberLocation(currentFilePath, from, typeName, memberName, { vfs: context.vfs });
    if (location) {
      return {
        uri: pathToUri(location.typingsPath),
        range: location.range
      };
    }
  }
  return null;
}

/**
 * Resolves a member access (`receiver.member`) to a top-level extension
 * declaration whose receiver type matches the static type of `receiver`.
 * Handles both extension properties (`val number.seconds: ...`) and extension
 * methods (`fun Point.foo(): ...`) declared in the current file or any file the
 * current document imports.
 */
async function resolveExtensionMemberDefinitionAcrossFiles(
  context: ResolveContext,
  receiverTypeName: string,
  memberName: string
): Promise<Location | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  const roots = context.sourceRoots.length > 0 ? context.sourceRoots : [dirname(currentFilePath)];
  const resolved = await resolveTopLevelDeclarationAcrossFiles({
    ast: context.session.ast,
    name: memberName,
    currentFilePath,
    predicate: (statement): statement is VarStatement | FunctionStatement => {
      if (statement.kind !== "VarStatement" && statement.kind !== "FunctionStatement") {
        return false;
      }
      return (statement as VarStatement | FunctionStatement).receiverType?.name === receiverTypeName;
    },
    sourceRoots: roots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });

  if (!resolved) {
    return null;
  }

  const range = nodeRange(resolved.declaration.name);
  if (!range) {
    return null;
  }

  return {
    uri: pathToUri(resolved.filePath === "" ? currentFilePath : resolved.filePath),
    range
  };
}

function findClassMemberDeclarationAtPosition(
  program: Program,
  line: number,
  character: number
): { className: string; member: ClassMemberInfo } | null {
  for (const statement of program.body) {
    if (statement.kind !== "ClassStatement") {
      continue;
    }
    const classStatement = statement as ClassStatement;
    for (const parameter of classPropertyParameters(classStatement)) {
      const member = classMemberInfoByName(classStatement, bindingNameText(parameter.name));
      if (!member || !containsPosition(member.range, { line, character })) {
        continue;
      }
      return {
        className: classStatement.name.name,
        member
      };
    }
    for (const classMember of classStatement.members) {
      const member = classMemberInfoByName(classStatement, classMember.name.name);
      if (!member || !containsPosition(member.range, { line, character })) {
        continue;
      }
      return {
        className: classStatement.name.name,
        member
      };
    }
  }

  return null;
}

async function resolveCanonicalMemberSymbol(context: ResolveContext): Promise<CanonicalMemberSymbol | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }

  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath) {
    return null;
  }

  const declaration = findClassMemberDeclarationAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (declaration) {
    return {
      className: declaration.className,
      memberName: declaration.member.memberName,
      filePath: currentFilePath,
      range: declaration.member.range
    };
  }

  const memberExpression = findMemberExpressionAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (!memberExpression || memberExpression.property.kind !== "Identifier") {
    return null;
  }

  const objectType = context.session.analysis.getExpressionTypes().get(memberExpression.object);
  if (!objectType || (objectType.kind !== "named" && objectType.kind !== "array")) {
    return null;
  }

  const resolvedClassName = objectType.kind === "array" ? "Array" : objectType.name;
  const classResolution = await resolveTypeDefinitionAcrossFiles(context, resolvedClassName);
  if (!classResolution) {
    return null;
  }

  const memberName = (memberExpression.property as Identifier).name;
  const memberInfo = classMemberInfoByName(classResolution.declaration, memberName);
  if (!memberInfo) {
    return null;
  }

  return {
    className: resolvedClassName,
    memberName,
    filePath: classResolution.filePath,
    range: memberInfo.range
  };
}

function collectMemberExpressions(program: Program): MemberExpression[] {
  const expressions: MemberExpression[] = [];

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "MemberExpression": {
        const member = expression as MemberExpression;
        expressions.push(member);
        visitExpression(member.object);
        if (member.computed) {
          visitExpression(member.property);
        }
        return;
      }
      case "CallExpression":
        visitExpression((expression as CallExpression).callee);
        for (const argument of (expression as CallExpression).arguments) {
          visitExpression(argument);
        }
        return;
      case "NewExpression":
        visitExpression((expression as NewExpression).callee);
        for (const argument of (expression as NewExpression).arguments ?? []) {
          visitExpression(argument);
        }
        return;
      case "CommaExpression":
        for (const child of (expression as CommaExpression).expressions) {
          visitExpression(child);
        }
        return;
      case "AsExpression":
        visitExpression((expression as AsExpression).expression);
        return;
      case "NonNullExpression":
        visitExpression((expression as NonNullExpression).expression);
        return;
      case "BinaryExpression":
        visitExpression((expression as BinaryExpression).left);
        visitExpression((expression as BinaryExpression).right);
        return;
      case "RangeExpression":
        visitExpression((expression as RangeExpression).start);
        visitExpression((expression as RangeExpression).end);
        return;
      case "AssignmentExpression":
        visitExpression((expression as AssignmentExpression).left);
        visitExpression((expression as AssignmentExpression).right);
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
          if (property.kind === "ObjectSpreadProperty") {
            visitExpression(property.argument);
          } else {
            visitExpression(property.value);
          }
        }
        return;
      case "ArrowFunctionExpression": {
        const body = (expression as ArrowFunctionExpression).body;
        if (body.kind === "BlockStatement") {
          for (const child of (body as BlockStatement).body) {
            visitStatement(child);
          }
        } else {
          visitExpression(body as Expr);
        }
        return;
      }
      case "FunctionExpression":
        for (const child of (expression as FunctionExpression).body.body) {
          visitStatement(child);
        }
        return;
      default:
        return;
    }
  };

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "VarStatement":
        if ((statement as VarStatement).declarations && (statement as VarStatement).declarations!.length > 0) {
          for (const declaration of (statement as VarStatement).declarations!) {
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
      case "WithStatement":
        visitExpression((statement as WithStatement).object);
        visitStatement((statement as WithStatement).body);
        return;
      case "LabeledStatement":
        visitStatement((statement as LabeledStatement).body);
        return;
      case "DoWhileStatement":
        visitStatement((statement as DoWhileStatement).body);
        visitExpression((statement as DoWhileStatement).condition);
        return;
      case "ForStatement":
        if ((statement as ForStatement).initializer && (statement as ForStatement).initializer!.kind !== "VarStatement") {
          visitExpression((statement as ForStatement).initializer as Expr);
        } else if ((statement as ForStatement).initializer && (statement as ForStatement).initializer!.kind === "VarStatement") {
          visitStatement((statement as ForStatement).initializer as Statement);
        }
        if ((statement as ForStatement).iterator && (statement as ForStatement).iterator!.kind !== "VarStatement" && (statement as ForStatement).iterator!.kind !== "Identifier") {
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

  for (const statement of program.body) {
    visitStatement(statement);
  }

  return expressions;
}

async function resolveMemberReferencesAcrossFiles(
  context: ResolveContext,
  includeDeclaration: boolean
): Promise<Location[]> {
  const memberSymbol = await resolveCanonicalMemberSymbol(context);
  if (!memberSymbol) {
    return [];
  }

  const roots = context.sourceRoots.length > 0 ? context.sourceRoots : [dirname(memberSymbol.filePath)];
  const files = await scanProjectMyFiles(roots, context.vfs);
  const locations: Location[] = [];
  const seen = new Set<string>();

  const addLocation = (uri: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
    const key = `${uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    locations.push({ uri, range });
  };

  if (includeDeclaration) {
    addLocation(pathToUri(memberSymbol.filePath), memberSymbol.range);
  }

  for (const filePath of files) {
    const session = await getSessionForFilePath(filePath, context);
    if (!session?.ast || !session.analysis) {
      continue;
    }

    const expressionTypes = session.analysis.getExpressionTypes();
    for (const member of collectMemberExpressions(session.ast)) {
      if (member.computed || member.property.kind !== "Identifier") {
        continue;
      }
      const memberName = (member.property as Identifier).name;
      if (memberName !== memberSymbol.memberName) {
        continue;
      }
      const objectType = expressionTypes.get(member.object);
      if (!objectType || (objectType.kind !== "named" && objectType.kind !== "array")) {
        continue;
      }
      const objectClassName = objectType.kind === "array" ? "Array" : objectType.name;
      if (objectClassName !== memberSymbol.className) {
        continue;
      }
      const range = nodeRange(member.property);
      if (!range) {
        continue;
      }
      addLocation(pathToUri(filePath), range);
    }
  }

  return locations;
}

function findImportStringLiteralAtPosition(
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

async function resolveImportPathDefinition(context: ResolveContext): Promise<Location | null> {
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
  if (!resolvedPath) return null;

  return {
    uri: pathToUri(resolvedPath),
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
  };
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

export async function resolveDefinitionAcrossFiles(context: ResolveContext): Promise<Location | null> {
  const importPathDefinition = await resolveImportPathDefinition(context);
  if (importPathDefinition) {
    return importPathDefinition;
  }

  const memberDefinition = await resolveMemberDefinitionAcrossFiles(context);
  if (memberDefinition) {
    return memberDefinition;
  }

  const typeIdentifier = context.session.ast
    ? findTypeIdentifierAtPosition(context.session.ast, context.line, context.character)
    : null;
  if (typeIdentifier) {
    const typeDefinition = await resolveTypeDefinitionAcrossFiles(context, typeIdentifier.name);
    if (typeDefinition) {
      return {
        uri: pathToUri(typeDefinition.filePath),
        range: nodeRange(typeDefinition.declaration.name) ?? nodeRange(typeIdentifier)!
      };
    }
  }

  const symbol = await resolveCanonicalSymbol(context);
  if (symbol) {
    return {
      uri: pathToUri(symbol.filePath),
      range: symbol.range
    };
  }
  return null;
}

function createMemberHoverContents(
  member: ClassMemberInfo
): string {
  return `${member.memberName}: ${member.typeLabel}`;
}

export async function resolveMemberHoverAcrossFiles(context: ResolveContext): Promise<Hover | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }

  const declaration = findClassMemberDeclarationAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (declaration) {
    return {
      contents: {
        kind: "plaintext",
        value: createMemberHoverContents(declaration.member)
      },
      range: declaration.member.range
    };
  }

  const memberExpression = findMemberExpressionAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (!memberExpression || memberExpression.property.kind !== "Identifier") {
    return null;
  }

  const objectType = context.session.analysis.getExpressionTypes().get(memberExpression.object);
  if (!objectType) {
    return null;
  }

  const memberName = (memberExpression.property as Identifier).name;
  const objectTypeLabel = typeToString(objectType);
  const structuralMember = parseObjectTypeMemberInfo(objectTypeLabel, memberName);
  const resolvedClassName = objectType.kind === "array"
    ? "Array"
    : objectType.kind === "named" || objectType.kind === "builtin"
      ? boxedNavigationTypeName(objectType.name)
      : null;
  const classResolution = resolvedClassName
    ? await resolveTypeDefinitionAcrossFiles(context, resolvedClassName)
    : null;
  if (!classResolution) {
    if (!structuralMember) {
      return null;
    }
    const memberRange = nodeRange(memberExpression.property) ?? nodeRange(memberExpression);
    return {
      contents: {
        kind: "plaintext",
        value: `${memberName}: ${structuralMember.typeLabel}`
      },
      ...(memberRange ? { range: memberRange } : {})
    };
  }
  const resolvedMember = classResolution.declaration.kind === "ClassStatement"
    ? await resolveClassMember(
      classResolution.declaration,
      memberName,
      objectType.kind === "array" ? `Array<${typeToString(objectType.elementType)}>` : typeToString(objectType),
      {
        ast: context.session.ast,
        options: {
          uri: context.uri,
          sourceRoots: context.sourceRoots,
          ...(context.getSessionForFilePath
            ? { getSessionForFilePath: context.getSessionForFilePath }
            : {})
        },
        analysis: context.session.analysis,
        cache: createClassResolverCache()
      }
    )
    : await resolveInterfaceMember(
      classResolution.declaration,
      memberName,
      objectType.kind === "array" ? `Array<${typeToString(objectType.elementType)}>` : typeToString(objectType),
      {
        ast: context.session.ast,
        options: {
          uri: context.uri,
          sourceRoots: context.sourceRoots,
          ...(context.getSessionForFilePath
            ? { getSessionForFilePath: context.getSessionForFilePath }
            : {})
        },
        analysis: context.session.analysis,
        cache: createClassResolverCache()
      }
    );
  const fallbackMember = classMemberInfoByName(classResolution.declaration, memberName);
  if (!resolvedMember && !fallbackMember && !structuralMember) {
    return null;
  }
  const memberRange = nodeRange(memberExpression.property) ?? nodeRange(memberExpression);
  return {
    contents: {
      kind: "plaintext",
      value: `${memberName}: ${resolvedMember?.typeName ?? fallbackMember?.typeLabel ?? structuralMember!.typeLabel}`
    },
    ...(memberRange ? { range: memberRange } : {})
  };
}

export async function resolveReferencesAcrossFiles(
  context: ResolveContext,
  includeDeclaration: boolean
): Promise<Location[]> {
  const memberLocations = await resolveMemberReferencesAcrossFiles(context, includeDeclaration);
  if (memberLocations.length > 0) {
    return memberLocations;
  }

  const localFallbackReferences = localReferencesFromContext(context, includeDeclaration);
  const symbol = await resolveCanonicalSymbol(context);
  if (!symbol) {
    return localFallbackReferences;
  }

  const roots = context.sourceRoots.length > 0 ? context.sourceRoots : [dirname(symbol.filePath)];
  const projectIndex = getProjectIndex(roots, context.vfs);
  const files = await scanProjectMyFiles(roots, context.vfs);
  const locations: Location[] = [];
  const seen = new Set<string>();

  const addLocation = (uri: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
    const key = `${uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    locations.push({ uri, range });
  };

  const importerByPath = new Map<string, Array<{ line: number; character: number }>>();
  for (const importer of await projectIndex.findFilesImportingSymbol(symbol.filePath, symbol.name)) {
    const existing = importerByPath.get(importer.importerFilePath);
    if (existing) {
      existing.push(importer.importRange.start);
    } else {
      importerByPath.set(importer.importerFilePath, [importer.importRange.start]);
    }
  }

  for (const filePath of files) {
    const session = await getSessionForFilePath(filePath, context);
    if (!session?.ast || !session.analysis) {
      continue;
    }
    const uri = pathToUri(filePath);

    if (resolve(filePath) === resolve(symbol.filePath)) {
      const declaration = findTopLevelDeclarationByName(session.ast, symbol.name);
      const declarationRange = declaration ? declarationRangeForName(declaration, symbol.name) : null;
      if (!declarationRange) {
        for (const location of localFallbackReferences) {
          addLocation(location.uri, location.range);
        }
        continue;
      }

      const references = session.analysis.getReferenceRangesAt(
        declarationRange.start.line,
        declarationRange.start.character,
        includeDeclaration
      );
      for (const range of references) {
        addLocation(uri, range);
      }
      continue;
    }

    const importPositions =
      importerByPath.get(filePath) ??
      await findMatchingImportSpecifierPositions(session.ast, filePath, symbol, context);
    for (const position of importPositions) {
      const references = session.analysis.getReferenceRangesAt(
        position.line,
        position.character,
        includeDeclaration
      );
      for (const range of references) {
        addLocation(uri, range);
      }
    }
  }

  if (!includeDeclaration) {
    return locations.filter((location) => !(
      location.uri === pathToUri(symbol.filePath) && rangesEqual(location.range, symbol.range)
    ));
  }

  return locations;
}

export async function resolveRenameAcrossFiles(
  context: ResolveContext,
  newName: string
): Promise<WorkspaceEdit | null> {
  const locations = await resolveReferencesAcrossFiles(context, true);
  if (locations.length === 0) {
    return localRenameWorkspaceEdit(context, newName);
  }

  const changes: Record<string, Array<{ range: Location["range"]; newText: string }>> = {};
  for (const location of locations) {
    if (!changes[location.uri]) {
      changes[location.uri] = [];
    }
    changes[location.uri]?.push({
      range: location.range,
      newText: newName
    });
  }

  if (Object.keys(changes).length === 0) {
    return localRenameWorkspaceEdit(context, newName);
  }
  return { changes };
}
