import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { compileSource } from "compiler/pipeline/compile";
import type { InterfaceStatement, Statement } from "compiler/ast/ast";
import {
  COMPLETION_RECOVERY_MEMBER,
  CompletionItemKind,
  classResolverOptionsFromCompletionOptions,
  type CompletionRequestOptions,
  type InterfaceCompletionMember
} from "./completionModel";
import { createClassResolverCache } from "./classResolver";
import {
  findMemberAccessDot,
  parseMemberAccessTarget
} from "./memberCompletionParsing";
import { recoveredReceiverTypeName } from "./memberCompletionTypeNames";

export function collectAmbientInterfaceCompletionMembers(
  ambientDeclarations: Statement[],
  interfaceName: string
): InterfaceCompletionMember[] {
  const items: InterfaceCompletionMember[] = [];
  for (const statement of ambientDeclarations) {
    const declaration = unwrapExportedDeclaration(statement) ?? statement;
    if (declaration.kind !== "InterfaceStatement") {
      continue;
    }
    const interfaceStatement = declaration as InterfaceStatement;
    if (interfaceStatement.name.name !== interfaceName) {
      continue;
    }
    for (const member of interfaceStatement.members) {
      if (member.kind === "InterfacePropertyMember") {
        items.push({
          name: member.name.name,
          detail: `Interface property: ${member.typeAnnotation?.name ?? "unknown"}`,
          kind: CompletionItemKind.Field
        });
      } else if (member.kind === "InterfaceMethodMember") {
        items.push({
          name: member.name.name,
          detail: `Interface method: ${member.returnType?.name ?? "unknown"}`,
          kind: CompletionItemKind.Method
        });
      }
    }
  }
  return items;
}

export function recoverSourceForMemberAccessCompletion(
  text: string,
  line: number,
  character: number
): string | null {
  const target =
    parseMemberAccessTarget(text, line, character) ?? findMemberAccessDot(text, line, character);
  if (!target) {
    return null;
  }
  const lines = text.split("\n");
  const lineText = lines[line];
  if (lineText === undefined) {
    return null;
  }
  const clampedCharacter = Math.max(0, Math.min(character, lineText.length));
  const prefixStartCharacter = clampedCharacter - target.prefix.length;
  lines[line] =
    lineText.slice(0, prefixStartCharacter) +
    COMPLETION_RECOVERY_MEMBER +
    lineText.slice(clampedCharacter);
  return lines.join("\n");
}

export async function buildRecoveredMemberAccessCompletions(
  line: number,
  character: number,
  options: CompletionRequestOptions,
  buildMemberCompletionItemsForType: (params: {
    ast: NonNullable<Awaited<ReturnType<typeof compileSource>>["ast"]>;
    analysis: NonNullable<Awaited<ReturnType<typeof compileSource>>["analysis"]>;
    className: string;
    prefix: string;
    line: number;
    dotCharacter: number;
    character: number;
    options: CompletionRequestOptions;
    resolverOptions: ReturnType<typeof classResolverOptionsFromCompletionOptions>;
    resolverCache: ReturnType<typeof createClassResolverCache>;
  }) => Promise<any[]>,
  buildMemberAccessCompletions: (
    ast: NonNullable<Awaited<ReturnType<typeof compileSource>>["ast"]>,
    analysis: NonNullable<Awaited<ReturnType<typeof compileSource>>["analysis"]>,
    line: number,
    character: number,
    options: CompletionRequestOptions,
    allowRecovery?: boolean
  ) => Promise<any[] | null>
): Promise<any[] | null> {
  if (!options.text) {
    return null;
  }
  const recoveredSource = recoverSourceForMemberAccessCompletion(options.text, line, character);
  if (!recoveredSource || recoveredSource === options.text) {
    return null;
  }
  const recovered = options.recoverAnalysisSession
    ? await options.recoverAnalysisSession(recoveredSource)
    : compileSource(recoveredSource);
  if (!recovered.ast || !recovered.analysis) {
    return null;
  }
  const recoveredTypeName = recoveredReceiverTypeName(recovered.ast, recovered.analysis);
  if (recoveredTypeName && recoveredTypeName !== "unknown") {
    const dot = findMemberAccessDot(recoveredSource, line, character);
    if (dot) {
      const resolverOptions = classResolverOptionsFromCompletionOptions(options);
      const resolverCache = createClassResolverCache();
      const items = await buildMemberCompletionItemsForType({
        ast: recovered.ast,
        analysis: recovered.analysis,
        className: recoveredTypeName,
        prefix: dot.prefix,
        line,
        dotCharacter: dot.dotCharacter,
        character,
        options: {
          ...options,
          text: recoveredSource
        },
        resolverOptions,
        resolverCache
      });
      if (items.length > 0) {
        return items;
      }
    }
  }
  return buildMemberAccessCompletions(
    recovered.ast,
    recovered.analysis,
    line,
    character,
    {
      ...options,
      text: recoveredSource
    },
    false
  );
}
