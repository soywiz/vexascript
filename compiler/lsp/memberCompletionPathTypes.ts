import { type Analysis, type AnalysisSymbol } from "compiler/analysis/Analysis";
import { baseTypeName } from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
import type { Program } from "compiler/ast/ast";
import {
  resolveClassMember,
  resolveClassStatementAcrossFiles,
  resolveInterfaceMember,
  resolveInterfaceStatementAcrossFiles,
  type ClassResolverCache,
  type ClassResolverOptions
} from "./classResolver";
import {
  findIdentifierAtPosition,
  inferClassNameFromAstVariableInitializer,
  inferTypeNameFromAstBindingAnnotation
} from "./memberCompletionBindingTypes";
import {
  boxedCompletionTypeName,
  inferLiteralTypeName,
  nonNullishTypeName
} from "./memberCompletionTypeNames";

export type ResolveExtensionMemberTypeName = (
  ast: Program,
  objectTypeName: string,
  memberName: string,
  options: ClassResolverOptions,
  analysis?: Analysis | null
) => Promise<string | null>;

function typeNameFromSymbol(symbol: AnalysisSymbol): string | null {
  if (symbol.valueType && symbol.valueType !== "unknown") {
    return symbol.valueType;
  }
  if (symbol.type) {
    return typeToString(symbol.type);
  }
  return null;
}

function fallbackBindingTypeName(
  ast: Program,
  bindingName: string,
  line: number
): string | null {
  return (
    inferTypeNameFromAstBindingAnnotation(ast, bindingName, line) ??
    inferClassNameFromAstVariableInitializer(ast, bindingName, line)
  );
}

function initialTypeNameFromPathRoot(
  ast: Program,
  analysis: Analysis,
  firstSegment: string,
  line: number,
  objectStartCharacter: number
): string | null {
  const identifierAtCursor = findIdentifierAtPosition(ast, line, objectStartCharacter);
  if (identifierAtCursor) {
    const expressionType = analysis.getExpressionTypes().get(identifierAtCursor);
    const narrowedExpressionTypeName = nonNullishTypeName(
      expressionType ? typeToString(expressionType) : null
    );
    if (narrowedExpressionTypeName && narrowedExpressionTypeName !== "unknown") {
      return narrowedExpressionTypeName;
    }
    const annotatedTypeName = inferTypeNameFromAstBindingAnnotation(ast, identifierAtCursor.name, line);
    if (annotatedTypeName) {
      return annotatedTypeName;
    }
  }

  const literalTypeName = inferLiteralTypeName(firstSegment);
  if (literalTypeName) {
    return literalTypeName;
  }

  const symbolMatch = analysis.getSymbolAt(line, Math.max(0, objectStartCharacter));
  if (symbolMatch && symbolMatch.symbol.name === firstSegment) {
    return typeNameFromSymbol(symbolMatch.symbol);
  }

  const visibleSymbol = analysis.getVisibleSymbolsAt(line, objectStartCharacter)
    .find((candidate) => candidate.name === firstSegment);
  if (visibleSymbol) {
    return typeNameFromSymbol(visibleSymbol);
  }

  return fallbackBindingTypeName(ast, firstSegment, line);
}

async function nextTypeNameFromResolvedMember(
  ast: Program,
  analysis: Analysis,
  currentTypeName: string,
  memberName: string,
  resolverOptions: ClassResolverOptions,
  resolverCache: ClassResolverCache,
  resolveExtensionMemberTypeName: ResolveExtensionMemberTypeName
): Promise<string | null> {
  const boxedTypeName = boxedCompletionTypeName(currentTypeName);
  if (!boxedTypeName) {
    return null;
  }

  const baseName = baseTypeName(boxedTypeName);
  const classResolution = await resolveClassStatementAcrossFiles(
    ast,
    baseName,
    resolverOptions,
    resolverCache
  );
  if (classResolution) {
    const member = await resolveClassMember(classResolution.classStatement, memberName, boxedTypeName, {
      ast,
      options: resolverOptions,
      analysis,
      cache: resolverCache
    });
    if (member) {
      return member.kind === "method"
        ? member.signature?.returnTypeName ?? null
        : member.typeName;
    }
  }

  const interfaceStatement = (await resolveInterfaceStatementAcrossFiles(
    ast,
    baseName,
    resolverOptions,
    resolverCache
  ))?.interfaceStatement;
  if (interfaceStatement) {
    const member = await resolveInterfaceMember(interfaceStatement, memberName, boxedTypeName, {
      ast,
      options: resolverOptions,
      cache: resolverCache
    });
    if (member) {
      return member.kind === "method"
        ? member.signature?.returnTypeName ?? null
        : member.typeName;
    }
  }

  return resolveExtensionMemberTypeName(
    ast,
    boxedTypeName,
    memberName,
    { ...resolverOptions },
    analysis
  );
}

export async function resolveTypeNameFromPath(
  ast: Program,
  analysis: Analysis,
  pathSegments: string[],
  line: number,
  objectStartCharacter: number,
  resolverOptions: ClassResolverOptions,
  resolverCache: ClassResolverCache,
  resolveExtensionMemberTypeName: ResolveExtensionMemberTypeName
): Promise<string | null> {
  if (pathSegments.length === 0) {
    return null;
  }

  const firstSegment = pathSegments[0];
  if (!firstSegment) {
    return null;
  }

  let currentTypeName = initialTypeNameFromPathRoot(
    ast,
    analysis,
    firstSegment,
    line,
    objectStartCharacter
  );
  currentTypeName = nonNullishTypeName(currentTypeName);
  if (!currentTypeName || currentTypeName === "unknown") {
    currentTypeName = fallbackBindingTypeName(ast, firstSegment, line);
  }

  for (let index = 1; index < pathSegments.length; index += 1) {
    const memberName = pathSegments[index];
    if (!memberName || !currentTypeName) {
      return null;
    }
    currentTypeName = await nextTypeNameFromResolvedMember(
      ast,
      analysis,
      currentTypeName,
      memberName,
      resolverOptions,
      resolverCache,
      resolveExtensionMemberTypeName
    );
  }

  return currentTypeName;
}
