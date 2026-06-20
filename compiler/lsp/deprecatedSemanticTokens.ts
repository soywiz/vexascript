import { boxedPrimitiveTypeName } from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
import type { ClassStatement, Identifier, InterfaceStatement, MemberExpression, Program, Statement } from "compiler/ast/ast";
import type { SourceRange } from "compiler/parser/tokenizer";
import { unwrapExportedDeclaration, walkAst } from "compiler/ast/traversal";
import type { Hover } from "vscode-languageserver/node.js";
import {
  createClassResolverCache,
  resolveClassMember,
  resolveInterfaceMember,
  type ClassResolverOptions
} from "./classResolver";
import type { ResolveContext } from "./crossFileContext";
import { resolveMemberHoverAcrossFiles } from "./crossFileMemberHover";
import { DEPRECATED_TOKEN_MODIFIER, semanticTokenRangeKey } from "./semanticTokens";

export interface DeprecatedMemberRange {
  memberName: string;
  range: SourceRange;
}

function hoverValue(hover: Hover | null): string {
  const contents = hover?.contents;
  if (!contents) {
    return "";
  }
  if (typeof contents === "string") {
    return contents;
  }
  if (Array.isArray(contents)) {
    return contents.map((item) => typeof item === "string" ? item : item.value).join("\n");
  }
  return contents.value;
}

function containsDeprecatedTag(text: string): boolean {
  return /(^|\n)\s*@deprecated\b/.test(text);
}

function findExternalTypeDeclaration(
  statements: readonly Statement[] | undefined,
  typeName: string
): ClassStatement | InterfaceStatement | null {
  for (const statement of statements ?? []) {
    const declaration = unwrapExportedDeclaration(statement) ?? statement;
    if (declaration.kind === "ClassStatement" || declaration.kind === "InterfaceStatement") {
      const typeDeclaration = declaration as ClassStatement | InterfaceStatement;
      if (typeDeclaration.name.name === typeName) {
        return typeDeclaration;
      }
    }
  }
  return null;
}

function memberPropertyPosition(member: MemberExpression): { line: number; character: number } | null {
  if (member.computed || member.property.kind !== "Identifier" || !member.property.firstToken) {
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
  if (member.computed || member.property.kind !== "Identifier" || !context.session.analysis) {
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
  resolverContext: {
    ast: Program;
    options: ClassResolverOptions;
    analysis: NonNullable<ResolveContext["session"]["analysis"]>;
    cache: ReturnType<typeof createClassResolverCache>;
  },
  externalTypeDeclarations: Map<string, ClassStatement | InterfaceStatement | null>
): Promise<boolean> {
  if (member.computed || member.property.kind !== "Identifier" || !context.session.analysis || !context.session.ast) {
    return false;
  }

  const objectType = context.session.analysis.getExpressionTypes().get(member.object);
  if (!objectType) {
    return false;
  }
  const typeName = objectType.kind === "array"
    ? "Array"
    : objectType.kind === "named" || objectType.kind === "builtin"
      ? boxedPrimitiveTypeName(objectType.name)
      : null;
  const declaration = !typeName
    ? null
    : externalTypeDeclarations.has(typeName)
      ? externalTypeDeclarations.get(typeName) ?? null
      : (() => {
          const resolved = findExternalTypeDeclaration(context.session.externalDeclarations, typeName);
          externalTypeDeclarations.set(typeName, resolved);
          return resolved;
        })();
  if (!declaration) {
    return false;
  }
  const property = member.property as Identifier;
  const memberName = property.name;
  const objectTypeName = typeToString(objectType);
  const resolved = declaration.kind === "ClassStatement"
    ? await resolveClassMember(declaration, memberName, objectTypeName, resolverContext)
    : await resolveInterfaceMember(declaration, memberName, objectTypeName, resolverContext);
  return containsDeprecatedTag(resolved?.documentation ?? "");
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
  const externalTypeDeclarations = new Map<string, ClassStatement | InterfaceStatement | null>();
  const deprecatedStateByMemberKey = new Map<string, boolean>();

  const deprecatedMembers: DeprecatedMemberRange[] = [];
  const members: MemberExpression[] = [];
  walkAst(ast, (node) => {
    if (node.kind === "MemberExpression") {
      const member = node as MemberExpression;
      if (!member.computed && member.property.kind === "Identifier" && member.property.firstToken) {
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
    const memberKey = deprecatedMemberCacheKey(context, member);
    const cachedDeprecated = memberKey ? deprecatedStateByMemberKey.get(memberKey) : undefined;
    const isDeprecated = cachedDeprecated ?? await (async () => {
      const directDeprecated = await hasDeprecatedResolvedDocumentation(
        context,
        member,
        sharedResolverContext,
        externalTypeDeclarations
      );
      if (directDeprecated) {
        return true;
      }
      const hover = await resolveMemberHoverAcrossFiles(
        {
          ...context,
          line: position.line,
          character: position.character
        },
        {
          classResolverCache: sharedResolverContext.cache
        }
      );
      return containsDeprecatedTag(hoverValue(hover));
    })();
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
