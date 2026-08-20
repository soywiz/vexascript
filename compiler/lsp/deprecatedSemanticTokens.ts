import { ArrayType, NamedType, BuiltinType } from "../analysis/types";
import {
  ClassStatement,
  Identifier,
  InterfaceStatement,
  MemberExpression
} from "compiler/ast/ast";
import type { Node, Program } from "compiler/ast/ast";
import { boxedPrimitiveTypeName, parseTypeNameShape } from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
import { bindingNameText } from "compiler/ast/bindingPatterns";

import type { SourceRange } from "compiler/parser/tokenizer";
import { walkAst } from "compiler/ast/traversal";
import { getEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations.shared";
import {
  createClassResolverCache,
  resolveClassMember,
  resolveInterfaceMember,
  resolveClassStatementAcrossFiles,
  resolveInterfaceStatementAcrossFiles,
  type ClassResolverOptions
} from "./classResolver";
import type { ResolveContext } from "./crossFileContext";
import {
  readDocumentationInfoFromNamedNode,
  readDocumentationInfoFromParameterLike
} from "./documentation";
import { DEPRECATED_TOKEN_MODIFIER, semanticTokenRangeKey } from "./semanticTokens";

export interface DeprecatedMemberRange {
  memberName: string;
  range: SourceRange;
}

export interface DeprecatedSemanticTokenWorkMetrics {
  collections: number;
  candidateIndexRoots: number;
  candidateIndexRootCacheHits: number;
  candidateDeclarationNodesVisited: number;
  memberExpressionsVisited: number;
  candidateMemberExpressions: number;
  uniqueMemberResolutions: number;
  memberResolutionCacheHits: number;
}

function emptyDeprecatedSemanticTokenWorkMetrics(): DeprecatedSemanticTokenWorkMetrics {
  return {
    collections: 0,
    candidateIndexRoots: 0,
    candidateIndexRootCacheHits: 0,
    candidateDeclarationNodesVisited: 0,
    memberExpressionsVisited: 0,
    candidateMemberExpressions: 0,
    uniqueMemberResolutions: 0,
    memberResolutionCacheHits: 0
  };
}

interface DeprecatedDeclarationIndex {
  declaredOwners: Set<string>;
  classOwners: Set<string>;
  interfaceOwners: Set<string>;
  parentsByOwner: Map<string, Set<string>>;
  deprecatedOwnersByMember: Map<string, Set<string>>;
}

let workMetrics = emptyDeprecatedSemanticTokenWorkMetrics();
const deprecatedDeclarationsByRoot = new WeakMap<Node, DeprecatedDeclarationIndex>();

export function getDeprecatedSemanticTokenWorkMetrics(): Readonly<DeprecatedSemanticTokenWorkMetrics> {
  return { ...workMetrics };
}

export function resetDeprecatedSemanticTokenWorkMetrics(): void {
  workMetrics = emptyDeprecatedSemanticTokenWorkMetrics();
}

function emptyDeprecatedDeclarationIndex(): DeprecatedDeclarationIndex {
  return {
    declaredOwners: new Set(),
    classOwners: new Set(),
    interfaceOwners: new Set(),
    parentsByOwner: new Map(),
    deprecatedOwnersByMember: new Map()
  };
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key);
  if (values) {
    values.add(value);
  } else {
    map.set(key, new Set([value]));
  }
}

function declarationOwnerName(typeName: string): string {
  return parseTypeNameShape(typeName).baseName;
}

function deprecatedDeclarationsForRoot(root: Node): DeprecatedDeclarationIndex {
  workMetrics.candidateIndexRoots += 1;
  const cached = deprecatedDeclarationsByRoot.get(root);
  if (cached) {
    workMetrics.candidateIndexRootCacheHits += 1;
    return cached;
  }

  const index = emptyDeprecatedDeclarationIndex();
  walkAst(root, (node) => {
    workMetrics.candidateDeclarationNodesVisited += 1;
    if (node instanceof ClassStatement) {
      const owner = node.name.name;
      index.declaredOwners.add(owner);
      index.classOwners.add(owner);
      if (node.extendsType) {
        addToSetMap(index.parentsByOwner, owner, declarationOwnerName(node.extendsType.name));
      }
      for (const implementedType of node.implementsTypes ?? []) {
        addToSetMap(index.parentsByOwner, owner, declarationOwnerName(implementedType.name));
      }
      for (const member of node.members) {
        if (readDocumentationInfoFromNamedNode(member)?.deprecated === true) {
          addToSetMap(index.deprecatedOwnersByMember, member.name.name, owner);
        }
      }
      for (const parameter of node.primaryConstructorParameters ?? []) {
        if (readDocumentationInfoFromParameterLike(parameter)?.deprecated === true) {
          addToSetMap(index.deprecatedOwnersByMember, bindingNameText(parameter.name), owner);
        }
      }
    } else if (node instanceof InterfaceStatement) {
      const owner = node.name.name;
      index.declaredOwners.add(owner);
      index.interfaceOwners.add(owner);
      for (const parent of node.extendsTypes ?? []) {
        addToSetMap(index.parentsByOwner, owner, declarationOwnerName(parent.name));
      }
      for (const member of node.members) {
        if (readDocumentationInfoFromNamedNode(member)?.deprecated === true) {
          addToSetMap(index.deprecatedOwnersByMember, member.name.name, owner);
        }
      }
    }
    return true;
  });
  deprecatedDeclarationsByRoot.set(root, index);
  return index;
}

function collectDeprecatedDeclarationCandidates(
  context: Omit<ResolveContext, "line" | "character">,
  ast: Program
): DeprecatedDeclarationIndex {
  const combined = emptyDeprecatedDeclarationIndex();
  const roots: Node[] = [
    ast,
    getEcmaScriptRuntimeProgram(),
    ...(context.session.externalDeclarations ?? []),
    ...(context.session.ambientDeclarations ?? []),
    ...[...(context.session.ambientModuleDeclarations?.values() ?? [])].flatMap((declarations) => declarations)
  ];
  for (const root of roots) {
    const rootIndex = deprecatedDeclarationsForRoot(root);
    for (const owner of rootIndex.declaredOwners) {
      combined.declaredOwners.add(owner);
    }
    for (const owner of rootIndex.classOwners) {
      combined.classOwners.add(owner);
    }
    for (const owner of rootIndex.interfaceOwners) {
      combined.interfaceOwners.add(owner);
    }
    for (const [owner, parents] of rootIndex.parentsByOwner) {
      for (const parent of parents) {
        addToSetMap(combined.parentsByOwner, owner, parent);
      }
    }
    for (const [memberName, owners] of rootIndex.deprecatedOwnersByMember) {
      for (const owner of owners) {
        addToSetMap(combined.deprecatedOwnersByMember, memberName, owner);
      }
    }
  }
  return combined;
}

function memberResolverTypeName(
  context: Omit<ResolveContext, "line" | "character">,
  member: MemberExpression
): string | null {
  const objectType = context.session.analysis?.getExpressionTypes().get(member.object);
  if (!objectType) {
    return null;
  }
  return objectType instanceof ArrayType
    ? "Array"
    : objectType instanceof NamedType || objectType instanceof BuiltinType
      ? boxedPrimitiveTypeName(objectType.name)
      : null;
}

function declarationIndexMayDeprecateMember(
  index: DeprecatedDeclarationIndex,
  typeName: string,
  memberName: string
): boolean {
  const deprecatedOwners = index.deprecatedOwnersByMember.get(memberName);
  if (!deprecatedOwners) {
    return false;
  }
  if (!index.declaredOwners.has(typeName)) {
    return true;
  }
  const pending = [typeName];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const owner = pending.pop();
    if (!owner || visited.has(owner)) {
      continue;
    }
    visited.add(owner);
    if (deprecatedOwners.has(owner)) {
      return true;
    }
    pending.push(...(index.parentsByOwner.get(owner) ?? []));
  }
  return false;
}

function memberPropertyPosition(member: MemberExpression): { line: number; character: number } | null {
  if (member.computed || !(member.property instanceof Identifier) || !member.property.firstToken) {
    return null;
  }
  return {
    line: member.property.firstToken.range.start.line,
    character: member.property.firstToken.range.start.column
  };
}

function deprecatedMemberCacheKey(
  context: Omit<ResolveContext, "line" | "character">,
  member: MemberExpression
): string | null {
  if (member.computed || !(member.property instanceof Identifier) || !context.session.analysis) {
    return null;
  }
  const property = member.property as Identifier;
  const objectType = context.session.analysis.getExpressionTypes().get(member.object);
  if (!objectType) {
    return null;
  }
  return `${typeToString(objectType)}::${property.name}`;
}

async function hasDeprecatedResolvedDocumentation(
  context: Omit<ResolveContext, "line" | "character">,
  member: MemberExpression,
  resolutionKinds: { class: boolean; interface: boolean },
  resolverContext: {
    ast: Program;
    options: ClassResolverOptions;
    analysis: NonNullable<ResolveContext["session"]["analysis"]>;
    cache: ReturnType<typeof createClassResolverCache>;
  }
): Promise<boolean> {
  if (member.computed || !(member.property instanceof Identifier) || !context.session.analysis || !context.session.ast) {
    return false;
  }

  const objectType = context.session.analysis.getExpressionTypes().get(member.object);
  if (!objectType) {
    return false;
  }
  const typeName = objectType instanceof ArrayType
    ? "Array"
    : objectType instanceof NamedType || objectType instanceof BuiltinType
      ? boxedPrimitiveTypeName(objectType.name)
      : null;
  const property = member.property as Identifier;
  const memberName = property.name;
  const objectTypeName = typeToString(objectType);
  if (!typeName) {
    return false;
  }

  if (resolutionKinds.class) {
    const classResolution = await resolveClassStatementAcrossFiles(
      resolverContext.ast,
      typeName,
      resolverContext.options,
      resolverContext.cache
    );
    if (classResolution) {
      const resolved = await resolveClassMember(
        classResolution.classStatement,
        memberName,
        objectTypeName,
        resolverContext
      );
      if (resolved?.deprecated) {
        return true;
      }
    }
  }

  if (!resolutionKinds.interface) {
    return false;
  }
  const interfaceResolution = await resolveInterfaceStatementAcrossFiles(
    resolverContext.ast,
    typeName,
    resolverContext.options,
    resolverContext.cache
  );
  if (!interfaceResolution) {
    return false;
  }
  const resolved = await resolveInterfaceMember(
    interfaceResolution.interfaceStatement,
    memberName,
    objectTypeName,
    resolverContext
  );
  return resolved?.deprecated === true;
}

export async function collectDeprecatedSemanticTokenModifiers(
  context: Omit<ResolveContext, "line" | "character">
): Promise<Map<string, number>> {
  const tokenModifiers = new Map<string, number>();
  for (const member of await collectDeprecatedMemberRanges(context)) {
    const key = semanticTokenRangeKey(member.range);
    tokenModifiers.set(key, (tokenModifiers.get(key) ?? 0) | DEPRECATED_TOKEN_MODIFIER);
  }
  return tokenModifiers;
}

export async function collectDeprecatedMemberRanges(
  context: Omit<ResolveContext, "line" | "character">
): Promise<DeprecatedMemberRange[]> {
  const ast = context.session.ast as Program | null;
  if (!ast || !context.session.analysis) {
    return [];
  }
  workMetrics.collections += 1;
  const deprecatedDeclarationCandidates = collectDeprecatedDeclarationCandidates(context, ast);

  const resolverOptions: ClassResolverOptions = {
    uri: context.uri,
    sourceRoots: context.sourceRoots,
    ...(context.getSessionForFilePath ? { getSessionForFilePath: context.getSessionForFilePath } : {}),
    ...(context.session.ambientModuleDeclarations
      ? { ambientModuleDeclarations: context.session.ambientModuleDeclarations }
      : {})
  };
  const sharedResolverContext = {
    ast,
    options: resolverOptions,
    analysis: context.session.analysis,
    cache: createClassResolverCache()
  };
  const deprecatedStateByMemberKey = new Map<string, boolean>();

  const deprecatedMembers: DeprecatedMemberRange[] = [];
  const members: MemberExpression[] = [];
  walkAst(ast, (node) => {
    if (node instanceof MemberExpression) {
      const member = node as MemberExpression;
      if (!member.computed && member.property instanceof Identifier && member.property.firstToken) {
        workMetrics.memberExpressionsVisited += 1;
        members.push(member);
      }
    }
    return true;
  });

  for (const member of members) {
    const position = memberPropertyPosition(member);
    if (!position || !member.property.firstToken) {
      continue;
    }
    const memberName = (member.property as Identifier).name;
    const resolverTypeName = memberResolverTypeName(context, member);
    if (
      !resolverTypeName
      || !declarationIndexMayDeprecateMember(deprecatedDeclarationCandidates, resolverTypeName, memberName)
    ) {
      continue;
    }
    workMetrics.candidateMemberExpressions += 1;
    const memberKey = deprecatedMemberCacheKey(context, member);
    const cachedDeprecated = memberKey ? deprecatedStateByMemberKey.get(memberKey) : undefined;
    if (cachedDeprecated !== undefined) {
      workMetrics.memberResolutionCacheHits += 1;
    } else {
      workMetrics.uniqueMemberResolutions += 1;
    }
    const hasKnownDeclarationKind = deprecatedDeclarationCandidates.declaredOwners.has(resolverTypeName);
    const isDeprecated = cachedDeprecated ?? await hasDeprecatedResolvedDocumentation(
      context,
      member,
      {
        class: !hasKnownDeclarationKind || deprecatedDeclarationCandidates.classOwners.has(resolverTypeName),
        interface: !hasKnownDeclarationKind || deprecatedDeclarationCandidates.interfaceOwners.has(resolverTypeName)
      },
      sharedResolverContext
    );
    if (memberKey) {
      deprecatedStateByMemberKey.set(memberKey, isDeprecated);
    }
    if (!isDeprecated) {
      continue;
    }
    deprecatedMembers.push({
      memberName: (member.property as Identifier).name,
      range: member.property.firstToken.range
    });
  }

  return deprecatedMembers;
}
