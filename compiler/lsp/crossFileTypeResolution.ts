import { NamedType, ArrayType } from "../analysis/types";
import { isNodeKind, NodeKind } from "compiler/ast/ast";
import { TokenType } from "compiler/parser/tokenizer";
/**
 * Shared cross-file member/type resolution helpers: class/interface/type-alias
 * member shape extraction, cross-file type-declaration resolution, and
 * position lookups for type identifiers, member expressions, and member
 * declarations. Used by the definition/hover/references operations in
 * crossFileNavigation.ts.
 */
import { classPropertyParameters } from "./classResolver";
import {
  ambientDeclarationLocationForSymbol,
  effectiveSourceRoots,
  preferVirtualRuntimeDeclarationFilePath,
  readTextDocument
} from "./crossFileContext";
import type { ResolveContext } from "./crossFileContext";
import { resolveTopLevelDeclarationAcrossFiles } from "./declarationResolver";
import { resolveInScopeExtensionMemberDeclarationAcrossFiles } from "./crossFileMemberDefinitionSources";
import { uriToFilePath } from "./importFixes";
import { findBestMatchAtPosition } from "./nodeSearch";
import { getNodeModuleTypings } from "./nodeModulesTypings";
import { containsPosition, nodeRange } from "./ranges";
import { formatFunctionTypeLabel } from "./functionTypeDisplay";
import { findMatchingTypeDelimiter, findTopLevelTypeCharacter, splitOptionalTypeSuffix, splitTopLevelDelimitedTypeText, splitTopLevelTypeText, stripEnclosingTypeParens } from "compiler/analysis/typeNames";
import { memberExpressionFromPropertyReference } from "compiler/ast/ast";
import type { ClassStatement, FunctionParameter, Identifier, ImportStatement, InterfaceStatement, MemberExpression, Program, PropertyReferenceExpression, Statement, TypeAliasStatement } from "compiler/ast/ast";
import { bindingNameText } from "compiler/ast/bindingPatterns";
import { unwrapExportedDeclaration, walkAst } from "compiler/ast/traversal";
import { getDomDeclarationFilePath } from "compiler/runtime/domDeclarations";
import { getEcmaScriptRuntimeDeclarationFilePath } from "compiler/runtime/ecmascriptDeclarations";
import { dirname } from "compiler/utils/path";


export interface CanonicalMemberSymbol {
  className: string;
  memberName: string;
  filePath: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface ClassMemberInfo {
  memberName: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  typeLabel: string;
  sourceKind: "primary-constructor" | "field" | "method";
}

export type TypeLikeDeclaration = ClassStatement | InterfaceStatement;

export interface ObjectTypeMemberInfo {
  memberName: string;
  typeLabel: string;
  kind: "field" | "method";
}

export const TYPE_ANNOTATION_KEYS = new Set([
  "typeAnnotation",
  "targetType",
  "returnType",
  "extendsType",
  "extendsTypes",
  "implementsTypes",
  "receiverType",
  "typeArguments",
  "constraint",
  "defaultType"
]);

export function classMemberDeclarationRangeByName(
  classStatement: TypeLikeDeclaration,
  memberName: string
): { start: { line: number; character: number }; end: { line: number; character: number } } | null {
  if (classStatement.kind === NodeKind.InterfaceStatement) {
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

export async function fallbackInterfaceMemberRangeInFile(
  context: ResolveContext,
  filePath: string,
  interfaceName: string,
  memberName: string
): Promise<{ start: { line: number; character: number }; end: { line: number; character: number } } | null> {
  const source = await readTextDocument(context, filePath);
  if (source === null) {
    return null;
  }
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

export async function fallbackTypeAliasMemberRangeInFile(
  context: ResolveContext,
  filePath: string,
  typeAliasName: string,
  memberName: string
): Promise<{ start: { line: number; character: number }; end: { line: number; character: number } } | null> {
  const source = await readTextDocument(context, filePath);
  if (source === null) {
    return null;
  }
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

export function functionTypeLabelFromParameters(
  parameters: FunctionParameter[],
  returnTypeName?: string
): string {
  const resolvedParameters = parameters.map((parameter) => ({
    name: bindingNameText(parameter.name),
    typeName: parameter.typeAnnotation?.name ?? "unknown",
    optional: parameter.optional === true,
    rest: parameter.rest === true
  }));
  return formatFunctionTypeLabel(resolvedParameters, returnTypeName ?? "void");
}

export function classMemberInfoByName(
  classStatement: TypeLikeDeclaration,
  memberName: string
): ClassMemberInfo | null {
  if (classStatement.kind === NodeKind.InterfaceStatement) {
    for (const member of classStatement.members) {
      if (member.name.name !== memberName) {
        continue;
      }
      const range = nodeRange(member.name);
      if (!range) {
        return null;
      }
      if (member.kind === NodeKind.InterfacePropertyMember) {
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
    if (member.kind === NodeKind.ClassFieldMember) {
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

export function parseObjectTypeMemberInfo(
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

export async function resolveTypeDefinitionAcrossFiles(
  context: ResolveContext,
  typeName: string,
  preferredAmbientFilePath?: string
): Promise<{ declaration: TypeLikeDeclaration; filePath: string } | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  const roots = effectiveSourceRoots(context.sourceRoots, currentFilePath);
  const resolved = await resolveTopLevelDeclarationAcrossFiles({
    ast: context.session.ast,
    name: typeName,
    currentFilePath,
    predicate: (statement): statement is TypeLikeDeclaration =>
      statement.kind === NodeKind.ClassStatement || statement.kind === NodeKind.InterfaceStatement,
    includeRuntime: true,
    sourceRoots: roots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });

  if (!resolved) {
    const nodeModuleResolved = await resolveImportedNodeModuleTypeDefinition(context, typeName);
    if (nodeModuleResolved) {
      return nodeModuleResolved;
    }

    const ambientDeclaration = findAmbientTypeDeclaration(
      context.session.ambientDeclarations ?? [],
      typeName,
      context.session.ambientDeclarationLocations,
      preferredAmbientFilePath
    );
    if (!ambientDeclaration) {
      return null;
    }
    const ambientLocation = ambientDeclarationLocationForSymbol(
      context.session,
      ambientDeclaration.name,
      typeName
    );
    return {
      declaration: ambientDeclaration,
      filePath: await preferVirtualRuntimeDeclarationFilePath(
        ambientLocation?.filePath ?? getDomDeclarationFilePath(),
        context
      )
    };
  }

  const resolvedFilePath = resolved.filePath === ""
    ? await getEcmaScriptRuntimeDeclarationFilePath()
    : resolved.filePath;
  return {
    declaration: resolved.declaration,
    filePath: await preferVirtualRuntimeDeclarationFilePath(resolvedFilePath, context)
  };
}

async function resolveImportedNodeModuleTypeDefinition(
  context: ResolveContext,
  typeName: string
): Promise<{ declaration: TypeLikeDeclaration; filePath: string } | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  for (const statement of context.session.ast.body) {
    if (statement.kind !== NodeKind.ImportStatement) {
      continue;
    }

    const importStatement = statement as ImportStatement;
    const importPath = importStatement.from.value;
    if (importPath.startsWith(".") || importPath.startsWith("/")) {
      continue;
    }

    const typings = await getNodeModuleTypings(currentFilePath, importPath, { vfs: context.vfs });
    if (!typings) {
      continue;
    }

    for (const entry of typings.declarationEntries) {
      const declaration = unwrapExportedDeclaration(entry.statement) ?? entry.statement;
      if (declaration.kind === NodeKind.ClassStatement) {
        const classDeclaration = declaration as ClassStatement;
        if (classDeclaration.name.name !== typeName) {
          continue;
        }
        return {
          declaration: classDeclaration,
          filePath: entry.typingsPath
        };
      }
      if (declaration.kind === NodeKind.InterfaceStatement) {
        const interfaceDeclaration = declaration as InterfaceStatement;
        if (interfaceDeclaration.name.name !== typeName) {
          continue;
        }
        return {
          declaration: interfaceDeclaration,
          filePath: entry.typingsPath
        };
      }
    }
  }

  return null;
}

export function findAmbientTypeDeclaration(
  declarations: Statement[],
  typeName: string,
  declarationLocations?: ReadonlyMap<Statement, { filePath: string }>,
  preferredFilePath?: string
): TypeLikeDeclaration | null {
  let fallbackMatch: TypeLikeDeclaration | null = null;
  let bestPreferredMatch: { declaration: TypeLikeDeclaration; score: number } | null = null;
  for (const statement of declarations) {
    const unwrapped = unwrapExportedDeclaration(statement) ?? statement;
    if (unwrapped.kind === NodeKind.ClassStatement || unwrapped.kind === NodeKind.InterfaceStatement) {
      const declaration = unwrapped as TypeLikeDeclaration;
      if (declaration.name.name === typeName) {
        if (preferredFilePath) {
          const location = declarationLocations?.get(statement) ?? declarationLocations?.get(unwrapped);
          const score = location?.filePath
            ? preferredAmbientDeclarationScore(location.filePath, preferredFilePath)
            : Number.POSITIVE_INFINITY;
          if (!bestPreferredMatch || score < bestPreferredMatch.score) {
            bestPreferredMatch = { declaration, score };
          }
        }
        fallbackMatch ??= declaration;
      }
    }
  }
  if (bestPreferredMatch && bestPreferredMatch.score !== Number.POSITIVE_INFINITY) {
    return bestPreferredMatch.declaration;
  }
  return fallbackMatch;
}

export function findAmbientTypeDeclarationOfKind(
  declarations: Statement[],
  typeName: string,
  kind: TypeLikeDeclaration["kind"],
  declarationLocations?: ReadonlyMap<Statement, { filePath: string }>,
  preferredFilePath?: string
): TypeLikeDeclaration | null {
  let fallbackMatch: TypeLikeDeclaration | null = null;
  let bestPreferredMatch: { declaration: TypeLikeDeclaration; score: number } | null = null;
  for (const statement of declarations) {
    const unwrapped = unwrapExportedDeclaration(statement) ?? statement;
    if (unwrapped.kind !== kind) {
      continue;
    }
    const declaration = unwrapped as TypeLikeDeclaration;
    if (declaration.name.name !== typeName) {
      continue;
    }
    if (preferredFilePath) {
      const location = declarationLocations?.get(statement) ?? declarationLocations?.get(unwrapped);
      const score = location?.filePath
        ? preferredAmbientDeclarationScore(location.filePath, preferredFilePath)
        : Number.POSITIVE_INFINITY;
      if (!bestPreferredMatch || score < bestPreferredMatch.score) {
        bestPreferredMatch = { declaration, score };
      }
    }
    fallbackMatch ??= declaration;
  }
  if (bestPreferredMatch && bestPreferredMatch.score !== Number.POSITIVE_INFINITY) {
    return bestPreferredMatch.declaration;
  }
  return fallbackMatch;
}

export async function resolveAmbientTypeDefinitionOfKind(
  context: ResolveContext,
  typeName: string,
  kind: TypeLikeDeclaration["kind"],
  preferredFilePath?: string
): Promise<{ declaration: TypeLikeDeclaration; filePath: string } | null> {
  const ambientDeclaration = findAmbientTypeDeclarationOfKind(
    context.session.ambientDeclarations ?? [],
    typeName,
    kind,
    context.session.ambientDeclarationLocations,
    preferredFilePath
  );
  if (!ambientDeclaration) {
    return null;
  }
  const ambientLocation = ambientDeclarationLocationForSymbol(
    context.session,
    ambientDeclaration.name,
    typeName
  );
  return {
    declaration: ambientDeclaration,
    filePath: await preferVirtualRuntimeDeclarationFilePath(
      ambientLocation?.filePath ?? getDomDeclarationFilePath(),
      context
    )
  };
}

function preferredAmbientDeclarationScore(candidateFilePath: string, preferredFilePath: string): number {
  if (candidateFilePath === preferredFilePath) {
    return 0;
  }
  if (dirname(candidateFilePath) === dirname(preferredFilePath)) {
    return 1;
  }
  const candidatePackageRoot = ambientPackageRoot(candidateFilePath);
  const preferredPackageRoot = ambientPackageRoot(preferredFilePath);
  if (candidatePackageRoot && preferredPackageRoot && candidatePackageRoot === preferredPackageRoot) {
    return 2;
  }
  return 3;
}

function ambientPackageRoot(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const atTypesMatch = normalized.match(/^(.*\/node_modules\/@types\/[^/]+)/);
  if (atTypesMatch?.[1]) {
    return atTypesMatch[1];
  }
  const packageMatch = normalized.match(/^(.*\/node_modules\/[^/]+)/);
  return packageMatch?.[1] ?? null;
}

export async function resolveTypeAliasDefinitionAcrossFiles(
  context: ResolveContext,
  typeName: string
): Promise<{ declaration: TypeAliasStatement; filePath: string } | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  const roots = effectiveSourceRoots(context.sourceRoots, currentFilePath);
  const resolved = await resolveTopLevelDeclarationAcrossFiles({
    ast: context.session.ast,
    name: typeName,
    currentFilePath,
    predicate: (statement): statement is TypeAliasStatement => statement.kind === NodeKind.TypeAliasStatement,
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

export function isAstNode(value: unknown): value is { kind: NodeKind } {
  return typeof value === "object" && value !== null && isNodeKind((value as { kind?: unknown }).kind);
}

function typeTextOffsetAtPosition(
  text: string,
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
  line: number,
  character: number
): number | null {
  if (!containsPosition(range, { line, character })) {
    return null;
  }
  if (range.start.line === range.end.line) {
    return Math.max(0, Math.min(text.length, character - range.start.character));
  }
  let offset = 0;
  let currentLine = range.start.line;
  let currentCharacter = range.start.character;
  while (offset < text.length) {
    if (currentLine === line && currentCharacter === character) {
      return offset;
    }
    if (text[offset] === "\n") {
      currentLine += 1;
      currentCharacter = 0;
    } else {
      currentCharacter += 1;
    }
    offset += 1;
  }
  if (currentLine === line && currentCharacter === character) {
    return offset;
  }
  return null;
}

function positionAtTypeTextOffset(
  text: string,
  range: { start: { line: number; character: number } },
  offset: number
): { line: number; character: number } {
  let line = range.start.line;
  let character = range.start.character;
  const clampedOffset = Math.max(0, Math.min(offset, text.length));
  for (let index = 0; index < clampedOffset; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }
  return { line, character };
}

function makeSyntheticTypeIdentifier(
  source: Identifier,
  name: string,
  startOffset: number,
  endOffset: number
): Identifier {
  const sourceRange = nodeRange(source)!;
  const start = positionAtTypeTextOffset(source.name, sourceRange, startOffset);
  const end = positionAtTypeTextOffset(source.name, sourceRange, endOffset);
  const baseOffset = source.firstToken?.range.start.offset ?? 0;
  const token: NonNullable<Identifier["firstToken"]> = {
    type: TokenType.IDENTIFIER,
    value: name,
    index: source.firstToken?.index ?? 0,
    range: {
      start: { line: start.line, column: start.character, offset: baseOffset + startOffset },
      end: { line: end.line, column: end.character, offset: baseOffset + endOffset }
    }
  };
  return {
    ...source,
    name,
    firstToken: token,
    lastToken: token
  };
}

function nestedTypeIdentifierAtOffset(
  identifier: Identifier,
  offset: number
): Identifier | null {
  const text = identifier.name;
  const sourceRange = nodeRange(identifier);
  if (!sourceRange) {
    return null;
  }
  const clampedOffset = Math.max(0, Math.min(offset, Math.max(0, text.length - 1)));

  const visit = (typeText: string, baseOffset: number): Identifier | null => {
    const optional = splitOptionalTypeSuffix(typeText);
    const normalized = stripEnclosingTypeParens(optional.typeName);
    const localOffset = clampedOffset - baseOffset;
    if (localOffset < 0 || localOffset > normalized.length) {
      return null;
    }

    const unionParts = splitTopLevelTypeText(normalized, "|");
    if (unionParts.length > 1) {
      let cursor = 0;
      for (const part of unionParts) {
        const partStart = normalized.indexOf(part, cursor);
        if (partStart < 0) {
          continue;
        }
        const nested = visit(part, baseOffset + partStart);
        if (nested) {
          return nested;
        }
        cursor = partStart + part.length;
      }
    }

    const intersectionParts = splitTopLevelTypeText(normalized, "&");
    if (intersectionParts.length > 1) {
      let cursor = 0;
      for (const part of intersectionParts) {
        const partStart = normalized.indexOf(part, cursor);
        if (partStart < 0) {
          continue;
        }
        const nested = visit(part, baseOffset + partStart);
        if (nested) {
          return nested;
        }
        cursor = partStart + part.length;
      }
    }

    const genericStart = findTopLevelTypeCharacter(normalized, "<");
    if (genericStart >= 0) {
      const genericEnd = findMatchingTypeDelimiter(normalized, genericStart, "<", ">");
      if (genericEnd > genericStart) {
        if (localOffset < genericStart) {
          const trailingWhitespace = normalized.slice(0, genericStart).match(/\s*$/)?.[0].length ?? 0;
          const baseEnd = genericStart - trailingWhitespace;
          const baseIdentifier = identifierFromQualifiedTypeText(
            normalized.slice(0, baseEnd),
            baseOffset,
            localOffset
          );
          if (baseIdentifier) {
            return baseIdentifier;
          }
        }
        if (localOffset > genericStart && localOffset < genericEnd) {
          const argumentBody = normalized.slice(genericStart + 1, genericEnd);
          const argumentsList = splitTopLevelDelimitedTypeText(argumentBody);
          let cursor = 0;
          for (const argument of argumentsList) {
            const argumentStart = argumentBody.indexOf(argument, cursor);
            if (argumentStart < 0) {
              continue;
            }
            const nested = visit(argument, baseOffset + genericStart + 1 + argumentStart);
            if (nested) {
              return nested;
            }
            cursor = argumentStart + argument.length;
          }
        }
      }
    }

    return identifierFromQualifiedTypeText(normalized, baseOffset, localOffset);
  };

  const identifierFromQualifiedTypeText = (
    typeText: string,
    baseOffset: number,
    localOffset: number
  ): Identifier | null => {
    const isIdentifierCharacter = (value: string | undefined) => !!value && /[A-Za-z0-9_$]/.test(value);
    let start = localOffset;
    let end = localOffset;
    while (start > 0 && isIdentifierCharacter(typeText[start - 1])) {
      start -= 1;
    }
    while (end < typeText.length && isIdentifierCharacter(typeText[end])) {
      end += 1;
    }
    if (start === end) {
      return null;
    }

    let qualifiedStart = start;
    while (qualifiedStart > 1 && typeText[qualifiedStart - 1] === ".") {
      let previousStart = qualifiedStart - 1;
      while (previousStart > 0 && isIdentifierCharacter(typeText[previousStart - 1])) {
        previousStart -= 1;
      }
      if (previousStart === qualifiedStart - 1) {
        break;
      }
      qualifiedStart = previousStart;
    }

    const memberName = typeText.slice(start, end).trim();
    const importTypeMatch = typeText
      .slice(0, qualifiedStart)
      .match(/(?:^|[^\w$])(?:typeof\s+)?import\s*\(\s*["']([^"']+)["']\s*\)\s*\.\s*$/);
    if (importTypeMatch && memberName) {
      const qualifiedName = typeText.slice(qualifiedStart, end).trim();
      return makeSyntheticTypeIdentifier(
        identifier,
        `import("${importTypeMatch[1]}").${qualifiedName}`,
        baseOffset + start,
        baseOffset + end
      );
    }

    const name = typeText.slice(qualifiedStart, end).trim();
    if (!name) {
      return null;
    }
    return makeSyntheticTypeIdentifier(identifier, name, baseOffset + start, baseOffset + end);
  };

  return visit(text, 0);
}

export function findTypeIdentifierAtPosition(
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
    const textOffset = typeTextOffsetAtPosition(identifier.name, range, line, character);
    const nestedIdentifier = textOffset !== null
      ? nestedTypeIdentifierAtOffset(identifier, textOffset)
      : null;
    if (nestedIdentifier) {
      identifier = nestedIdentifier;
    }
    const candidateRange = nodeRange(identifier);
    if (!candidateRange) {
      return;
    }
    const size =
      (candidateRange.end.line - candidateRange.start.line) * 100_000 +
      (candidateRange.end.character - candidateRange.start.character);
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
    if (entry.kind === NodeKind.Identifier) {
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

export function findMemberExpressionAtPosition(
  program: Program,
  line: number,
  character: number
): MemberExpression | null {
  return findBestMatchAtPosition(program, { line, character }, (node) => {
    if (node.kind === NodeKind.PropertyReferenceExpression) {
      const propertyReference = node as PropertyReferenceExpression;
      const propertyRange = nodeRange(propertyReference.property);
      return propertyRange
        ? {
            range: propertyRange,
            build: () => memberExpressionFromPropertyReference(propertyReference)
          }
        : null;
    }
    if (node.kind === NodeKind.MemberExpression) {
      const member = node as MemberExpression;
      if (member.computed || member.property.kind !== NodeKind.Identifier) {
        return null;
      }
      const propertyRange = nodeRange(member.property);
      return propertyRange ? { range: propertyRange, build: () => member } : null;
    }
    return null;
  });
}

export function findClassMemberDeclarationAtPosition(
  program: Program,
  line: number,
  character: number
): { className: string; member: ClassMemberInfo } | null {
  for (const statement of program.body) {
    if (statement.kind !== NodeKind.ClassStatement) {
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

export async function resolveCanonicalMemberSymbol(context: ResolveContext): Promise<CanonicalMemberSymbol | null> {
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
  if (!memberExpression || memberExpression.property.kind !== NodeKind.Identifier) {
    return null;
  }

  const objectType = context.session.analysis.getExpressionTypes().get(memberExpression.object);
  if (!objectType || (!(objectType instanceof NamedType) && !(objectType instanceof ArrayType))) {
    return null;
  }

  const resolvedClassName = objectType instanceof ArrayType ? "Array" : objectType.name;
  const memberName = (memberExpression.property as Identifier).name;

  // An in-scope extension member shadows the class member of the same name (the
  // type checker resolves the extension), so references and rename must anchor on
  // the extension declaration too — keeping every resolving surface (diagnostics,
  // hover, definition, completion, references/rename) consistent about which
  // member is in effect.
  const inScopeExtension = await resolveInScopeExtensionMemberDeclarationAcrossFiles(context, objectType, memberName);
  if (inScopeExtension) {
    const extensionRange = nodeRange(inScopeExtension.declaration.name);
    if (extensionRange) {
      return {
        className: resolvedClassName,
        memberName,
        filePath: inScopeExtension.filePath,
        range: extensionRange
      };
    }
  }

  const classResolution = await resolveTypeDefinitionAcrossFiles(context, resolvedClassName);
  if (!classResolution) {
    return null;
  }

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

export function collectMemberExpressions(program: Program): MemberExpression[] {
  const expressions: MemberExpression[] = [];
  walkAst(program, (node) => {
    if (node.kind === NodeKind.MemberExpression) {
      expressions.push(node as MemberExpression);
    }
  });
  return expressions;
}
