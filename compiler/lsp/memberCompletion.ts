/**
 * Member-access completion strategy: receiver detection and receiver-type
 * recovery around the cursor, cross-file class/interface/enum/type-alias
 * member item builders, extension-member completion, and namespace member
 * completion. Orchestrated by createCompletionItemsForPosition in
 * completion.ts.
 */
import { createClassResolverCache, resolveClassMember, resolveClassMemberNames, resolveClassStatementAcrossFiles, resolveInterfaceMember, resolveInterfaceMemberNames, resolveInterfaceStatementAcrossFiles } from "./classResolver";
import type { ClassResolverCache, ClassResolverOptions } from "./classResolver";
import { COMPLETION_RECOVERY_MEMBER, CompletionItemKind, classResolverOptionsFromCompletionOptions } from "./completionModel";
import type { CompletionRequestOptions, ExtensionMemberCompletionCandidate, InterfaceCompletionMember, MemberAccessTarget, TypeAliasCompletionMember } from "./completionModel";
import { resolveTopLevelDeclarationAcrossFiles } from "./declarationResolver";
import { buildExtensionAutoImportSuggestions } from "./importFixes";
import { getNodeModuleTypings } from "./nodeModulesTypings";
import { containsPosition, nodeRange, rangeSize } from "./ranges";
import { Analysis } from "compiler/analysis/Analysis";
import type { AnalysisSymbol } from "compiler/analysis/Analysis";
import { baseTypeName, boxedPrimitiveTypeName, findMatchingTypeDelimiter, findTopLevelTypeCharacter, parseTypeNameShape, splitTopLevelDelimitedTypeText, splitTopLevelTypeText, stripEnclosingTypeParens, substituteTypeNameText } from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
import type { AnalysisType } from "compiler/analysis/types";
import type { CallExpression, ClassMember, ClassStatement, EnumStatement, ExportStatement, Expr, FunctionParameter, FunctionStatement, Identifier, ImportStatement, InterfaceStatement, MemberExpression, NamespaceStatement, NewExpression, Program, Statement, TypeAliasStatement, TypeAnnotation, VarStatement } from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { unwrapExportedDeclaration, walkAst } from "compiler/ast/traversal";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import { compileSource } from "compiler/pipeline/compile";
import { fileURLToPath } from "compiler/utils/path";
import type { CompletionItem } from "vscode-languageserver/node.js";

export function operatorSymbolFromMemberName(name: string): string | null {
  return name.startsWith("operator") ? name.slice("operator".length) || null : null;
}

export function constructorParameterProperties(classStatement: ClassStatement) {
  return classStatement.members
    .filter((member) => member.kind === "ClassMethodMember" && member.name.name === "constructor")
    .flatMap((member) => member.kind === "ClassMethodMember" ? member.parameters : [])
    .filter((parameter) => parameter.accessModifier !== undefined || parameter.readonly === true);
}

export function classPropertyParameters(classStatement: ClassStatement) {
  return [...(classStatement.primaryConstructorParameters ?? []), ...constructorParameterProperties(classStatement)];
}

export function memberSortGroup(memberName: string, classStatement: ClassStatement, membersByName: Map<string, ClassMember>): string {
  if (classPropertyParameters(classStatement).some((parameter) => parameter.name.kind === "Identifier" && parameter.name.name === memberName)) {
    return "0";
  }
  const member = membersByName.get(memberName);
  if (member?.kind === "ClassFieldMember") {
    return "1";
  }
  return "2";
}

export function parseMemberAccessTarget(
  text: string | undefined,
  line: number,
  character: number
): MemberAccessTarget | null {
  if (!text) {
    return null;
  }
  const lines = text.split("\n");
  const lineText = lines[line];
  if (!lineText) {
    return null;
  }
  const clampedCharacter = Math.max(0, Math.min(character, lineText.length));
  const uptoCursor = lineText.slice(0, clampedCharacter);
  const match = /((?:[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?)(?:(?:\s*\?\.\s*|\s*!\.\s*|\s*\.\s*)[A-Za-z_][A-Za-z0-9_]*)*)(\?\.|!\.|\.)(?:\s*([A-Za-z_][A-Za-z0-9_]*))?$/.exec(uptoCursor);
  if (!match || !match[1]) {
    return null;
  }
  const objectPath = match[1];
  const typedPrefix = match[3] ?? "";
  const objectStartCharacter = match.index;
  const operator = match[2] ?? ".";
  const memberAccessStartCharacter = match.index + objectPath.length + operator.length - 1;
  return {
    objectPath: objectPath.replace(/\?\./g, ".").replace(/!\./g, ".").replace(/\s+/g, ""),
    objectStartCharacter,
    memberAccessStartCharacter,
    prefix: typedPrefix
  };
}

/**
 * Lenient member-access detection that, unlike {@link parseMemberAccessTarget},
 * does not require the receiver to be a plain identifier-dot chain. It only
 * locates the member-access dot and the partially typed member name, so the
 * receiver type can be resolved from the analyzed expression types instead of
 * from textual symbol lookups. This is what enables member completion after
 * complex receivers such as calls (e.g. `fetch(...).arrayBuffer`).
 */
export function findMemberAccessDot(
  text: string | undefined,
  line: number,
  character: number
): { dotCharacter: number; receiverEndCharacter: number; prefix: string } | null {
  if (!text) {
    return null;
  }
  const lines = text.split("\n");
  const lineText = lines[line];
  if (lineText === undefined) {
    return null;
  }
  const clampedCharacter = Math.max(0, Math.min(character, lineText.length));
  const uptoCursor = lineText.slice(0, clampedCharacter);
  const match = /(\?\.|!\.|\.)(?:\s*([A-Za-z_][A-Za-z0-9_]*))?$/.exec(uptoCursor);
  if (!match) {
    return null;
  }
  const operator = match[1] ?? ".";
  const dotCharacter = match.index + operator.length - 1;
  // The receiver must end with a value-producing token so that we are looking at
  // a member access rather than, for example, a decimal point in a number.
  // A trailing-lambda call receiver ends at its closing brace (`xs.map { it }.`),
  // so `}` must be accepted here too.
  const beforeDot = uptoCursor.slice(0, match.index).replace(/\s+$/, "");
  const lastChar = beforeDot[beforeDot.length - 1];
  if (!lastChar || !/[A-Za-z0-9_)\]"'`}!]/.test(lastChar)) {
    return null;
  }
  return { dotCharacter, receiverEndCharacter: beforeDot.length, prefix: match[2] ?? "" };
}

export function inferLiteralTypeName(pathSegment: string): string | null {
  if (/^\d+$/.test(pathSegment)) {
    return "int";
  }
  if (/^\d+\.\d+$/.test(pathSegment)) {
    return "number";
  }
  return null;
}

export function nonNullishTypeName(typeName: string | null): string | null {
  if (!typeName) {
    return null;
  }
  const parts = splitTopLevelTypeText(stripEnclosingTypeParens(typeName), "|")
    .map((part) => stripEnclosingTypeParens(part).trim())
    .filter((part) => part.length > 0 && part !== "null" && part !== "undefined");
  if (parts.length === 0) {
    return null;
  }
  return parts[0] ?? null;
}

export function normalizeRecoveredReceiverType(
  type: AnalysisType,
  node: Expr,
  expressionTypes: ReadonlyMap<import("compiler/ast/ast").Node, AnalysisType>
): string {
  if (type.kind === "union") {
    const nonNullish = type.types.filter((member) =>
      !(member.kind === "builtin" && (member.name === "null" || member.name === "undefined"))
    );
    const narrowed = nonNullish.length > 0 ? nonNullish : type.types;
    if (narrowed.length === 1) {
      return normalizeRecoveredReceiverType(narrowed[0]!, node, expressionTypes);
    }
    return narrowed.map((member) => normalizeRecoveredReceiverType(member, node, expressionTypes)).join(" | ");
  }
  if (type.kind === "named" && node.kind === "CallExpression") {
    const calleeType = expressionTypes.get((node as CallExpression).callee);
    const constraint = constraintForRecoveredTypeParameter(calleeType, type.name);
    if (constraint) {
      return typeToString(constraint);
    }
  }
  return typeToString(type);
}

function constraintForRecoveredTypeParameter(
  calleeType: AnalysisType | undefined,
  typeParameterName: string
): AnalysisType | null {
  if (!calleeType) {
    return null;
  }
  if (calleeType.kind === "function") {
    return calleeType.typeParameterConstraints?.[typeParameterName] ?? null;
  }
  if (calleeType.kind === "union") {
    for (const member of calleeType.types) {
      if (member.kind !== "function") {
        continue;
      }
      const constraint = member.typeParameterConstraints?.[typeParameterName];
      if (constraint) {
        return constraint;
      }
    }
  }
  return null;
}

export function receiverTypeNameEndingAt(
  analysis: Analysis,
  line: number,
  character: number
): string | null {
  let best: { node: Expr; type: AnalysisType; size: number } | null = null;
  let nearest: { node: Expr; type: AnalysisType; size: number; distance: number } | null = null;
  for (const [node, type] of analysis.getExpressionTypes()) {
    const range = nodeRange(node);
    if (!range || range.end.line !== line) {
      continue;
    }
    const size = rangeSize(range);
    if (range.end.character === character) {
      if (!best || size > best.size) {
        best = { node: node as Expr, type, size };
      }
      continue;
    }
    if (range.end.character > character) {
      continue;
    }
    const distance = character - range.end.character;
    if (distance > 2) {
      continue;
    }
    if (
      !nearest ||
      distance < nearest.distance ||
      (distance === nearest.distance && size > nearest.size)
    ) {
      nearest = { node: node as Expr, type, size, distance };
    }
  }
  const resolved = best ?? nearest;
  return resolved ? normalizeRecoveredReceiverType(resolved.type, resolved.node, analysis.getExpressionTypes()) : null;
}

export function recoveredReceiverTypeName(
  ast: Program,
  analysis: Analysis
): string | null {
  let recovered: { node: Expr; type: AnalysisType; size: number } | undefined;

  walkAst(ast, (node) => {
    if (node.kind !== "MemberExpression") {
      return;
    }
    const member = node as MemberExpression;
    if (
      member.computed ||
      member.property.kind !== "Identifier" ||
      !(member.property as Identifier).name.includes(COMPLETION_RECOVERY_MEMBER)
    ) {
      return;
    }
    const objectType = analysis.getExpressionTypes().get(member.object);
    if (!objectType) {
      return;
    }
    const range = nodeRange(member.object);
    const size = range ? rangeSize(range) : 0;
    if (!recovered || size >= recovered.size) {
      recovered = { node: member.object as Expr, type: objectType, size };
    }
  });

  if (recovered === undefined) {
    return null;
  }
  return normalizeRecoveredReceiverType(recovered.type, recovered.node, analysis.getExpressionTypes());
}

/**
 * Maps an array type name such as `int[]` to its `Array<int>` alias so member
 * completion resolves against the declared `class Array<T>`. Nested arrays peel
 * a single dimension (`int[][]` -> `Array<int[]>`). Returns `null` when the
 * type is not an array.
 */
export function arrayTypeNameToArrayAlias(typeName: string): string | null {
  const shape = parseTypeNameShape(typeName);
  if (shape.arrayDepth <= 0) {
    return null;
  }
  let elementType =
    shape.typeArguments.length > 0
      ? `${shape.baseName}<${shape.typeArguments.join(", ")}>`
      : shape.baseName;
  for (let depth = 0; depth < shape.arrayDepth - 1; depth += 1) {
    elementType += "[]";
  }
  return `Array<${elementType}>`;
}

export function boxedCompletionTypeName(typeName: string): string {
  return boxedPrimitiveTypeName(nonNullishTypeName(typeName) ?? typeName);
}

export function extensionReceiverMatches(receiverType: string, objectTypeName: string): boolean {
  // Array-shaped types (`int[]`, `Array<int>`) resolve their extension members
  // against the `Array` receiver, so `[].extensionMember` and `someArray.method()`
  // surface generic `Array<T>` extensions.
  const shape = parseTypeNameShape(objectTypeName);
  if (shape.arrayDepth > 0 && receiverType === "Array") {
    return true;
  }
  const normalized = shape.baseName;
  return receiverType === normalized || (normalized === "int" && receiverType === "number");
}

export function inferExtensionReturnTypeName(
  statement: Statement,
  analysis: Analysis | null
): string | null {
  if (statement.kind === "VarStatement") {
    const variable = statement as VarStatement;
    if (variable.typeAnnotation?.name) {
      return variable.typeAnnotation.name;
    }
    if (variable.initializer && analysis) {
      const initializerType = analysis.getExpressionTypes().get(variable.initializer);
      const typeName = initializerType ? typeToString(initializerType) : null;
      if (typeName && typeName !== "unknown") {
        return typeName;
      }
    }
    const initializer = variable.initializer;
    if (initializer?.kind === "CallExpression") {
      const call = initializer as CallExpression;
      if (call.callee.kind === "Identifier") {
        return (call.callee as Identifier).name;
      }
    }
    if (initializer?.kind === "NewExpression") {
      const newExpression = initializer as NewExpression;
      if (newExpression.callee.kind === "Identifier") {
        return (newExpression.callee as Identifier).name;
      }
    }
    return null;
  }
  if (statement.kind === "FunctionStatement") {
    return (statement as FunctionStatement).returnType?.name ?? null;
  }
  return null;
}

export async function collectAvailableExtensionMembers(
  ast: Program,
  objectTypeName: string,
  options: CompletionRequestOptions,
  analysis: Analysis | null = null
): Promise<ExtensionMemberCompletionCandidate[]> {
  const currentFilePath = options.uri?.startsWith("file://")
    ? fileURLToPath(options.uri)
    : null;
  const importedNames = new Set<string>();
  const candidates: ExtensionMemberCompletionCandidate[] = [];
  const seen = new Set<string>();

  const maybePushStatement = (statement: Statement): void => {
    const candidate = statement.kind === "ExportStatement"
      ? (statement as ExportStatement).declaration
      : statement;
    if (!candidate) {
      return;
    }
    if (candidate.kind === "VarStatement") {
      const variable = candidate as VarStatement;
      const receiverType = variable.receiverType?.name;
      if (!receiverType || !extensionReceiverMatches(receiverType, objectTypeName)) {
        return;
      }
      const bindings = variable.declarations?.flatMap((item) => bindingIdentifiers(item.name)) ?? bindingIdentifiers(variable.name);
      for (const binding of bindings) {
        if (seen.has(`property:${binding.name}`)) {
          continue;
        }
        seen.add(`property:${binding.name}`);
        candidates.push({
          name: binding.name,
          receiverType,
          kind: "property",
          returnTypeName: inferExtensionReturnTypeName(variable, analysis)
        });
      }
      return;
    }
    if (candidate.kind === "FunctionStatement") {
      const fn = candidate as FunctionStatement;
      const receiverType = fn.receiverType?.name;
      if (!receiverType || fn.operator || !extensionReceiverMatches(receiverType, objectTypeName)) {
        return;
      }
      if (seen.has(`method:${fn.name.name}`)) {
        return;
      }
      seen.add(`method:${fn.name.name}`);
      candidates.push({
        name: fn.name.name,
        receiverType,
        kind: "method",
        returnTypeName: inferExtensionReturnTypeName(fn, analysis)
      });
    }
  };

  for (const statement of ast.body) {
    maybePushStatement(statement);
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    for (const specifier of importStatement.specifiers) {
      importedNames.add((specifier.local ?? specifier.imported).name);
    }
  }

  if (!currentFilePath || !options.getSessionForFilePath) {
    return candidates;
  }

  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const targetFilePath = await resolveImportTargetFilePath(currentFilePath, importStatement.from.value, {
      ...(options.vfs ? { vfs: options.vfs } : {}),
      getSessionForFilePath: options.getSessionForFilePath
    });
    if (!targetFilePath) {
      continue;
    }
    const importedSession = await options.getSessionForFilePath(targetFilePath);
    const importedAst = importedSession?.ast;
    const importedAnalysis = importedSession?.analysis ?? null;
    if (!importedAst) {
      continue;
    }
    for (const importedStatement of importedAst.body) {
      const unwrapped = importedStatement.kind === "ExportStatement"
        ? (importedStatement as ExportStatement).declaration
        : importedStatement;
      if (!unwrapped) {
        continue;
      }
      if (unwrapped.kind === "VarStatement") {
        const variable = unwrapped as VarStatement;
        const receiverType = variable.receiverType?.name;
        if (!receiverType || !extensionReceiverMatches(receiverType, objectTypeName)) {
          continue;
        }
        const bindings = variable.declarations?.flatMap((item) => bindingIdentifiers(item.name)) ?? bindingIdentifiers(variable.name);
        for (const binding of bindings) {
          if (!importedNames.has(binding.name) || seen.has(`property:${binding.name}`)) {
            continue;
          }
          seen.add(`property:${binding.name}`);
          candidates.push({
            name: binding.name,
            receiverType,
            kind: "property",
            returnTypeName: inferExtensionReturnTypeName(variable, importedAnalysis)
          });
        }
        continue;
      }
      if (unwrapped.kind === "FunctionStatement") {
        const fn = unwrapped as FunctionStatement;
        const receiverType = fn.receiverType?.name;
        if (!receiverType || fn.operator || !extensionReceiverMatches(receiverType, objectTypeName)) {
          continue;
        }
        if (!importedNames.has(fn.name.name) || seen.has(`method:${fn.name.name}`)) {
          continue;
        }
        seen.add(`method:${fn.name.name}`);
        candidates.push({
          name: fn.name.name,
          receiverType,
          kind: "method",
          returnTypeName: inferExtensionReturnTypeName(fn, importedAnalysis)
        });
      }
    }
  }

  return candidates;
}

export async function resolveExtensionMemberTypeName(
  ast: Program,
  objectTypeName: string,
  memberName: string,
  options: CompletionRequestOptions,
  analysis?: Analysis | null
): Promise<string | null> {
  const candidate = (await collectAvailableExtensionMembers(ast, objectTypeName, options, analysis))
    .find((item) => item.name === memberName);
  return candidate?.returnTypeName ?? null;
}

export async function buildExtensionMemberCompletionItems(
  ast: Program,
  objectTypeName: string,
  prefix: string,
  options: CompletionRequestOptions,
  analysis?: Analysis | null
): Promise<CompletionItem[]> {
  const normalizedPrefix = prefix.trim();
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  const pushItem = (item: CompletionItem): void => {
    if (normalizedPrefix.length > 0 && !item.label.startsWith(normalizedPrefix)) {
      return;
    }
    if (seen.has(item.label)) {
      return;
    }
    seen.add(item.label);
    items.push(item);
  };

  for (const candidate of await collectAvailableExtensionMembers(ast, objectTypeName, options, analysis)) {
    pushItem({
      label: candidate.name,
      kind: candidate.kind === "method" ? CompletionItemKind.Method : CompletionItemKind.Property,
      detail: `Extension ${candidate.kind}: ${candidate.receiverType}`,
      sortText: `3-${candidate.name}`
    });
  }

  if (options.uri && (options.sourceRoots?.length || options.getExportedSymbols)) {
    const autoImports = await buildExtensionAutoImportSuggestions({
      uri: options.uri,
      ast,
      sourceRoots: options.sourceRoots ?? [],
      ...(options.getExportedSymbols ? { getExportedSymbols: options.getExportedSymbols } : {}),
      receiverType: baseTypeName(objectTypeName),
      prefix: normalizedPrefix,
      excludeSymbols: seen
    });
    for (const suggestion of autoImports) {
      pushItem({
        label: suggestion.symbol.name,
        kind: suggestion.symbol.memberKind === "method" ? CompletionItemKind.Method : CompletionItemKind.Property,
        detail: `Auto import extension from ${suggestion.importPath}`,
        sortText: `4-${suggestion.symbol.name}`,
        additionalTextEdits: [
          {
            range: suggestion.range,
            newText: `import { ${suggestion.symbol.name} } from "${suggestion.importPath}"\n`
          }
        ]
      });
    }
  }

  return items.sort((left, right) => left.label.localeCompare(right.label));
}

export async function buildClassMemberCompletionItems(
  classStatement: ClassStatement,
  objectTypeName: string | undefined,
  prefix: string,
  analysis: Analysis,
  memberAccessEdit:
    | {
        line: number;
        dotCharacter: number;
        prefixEndCharacter: number;
      }
    | undefined,
  resolverContext: {
    ast: Program;
    options: ClassResolverOptions;
    cache: ClassResolverCache;
  }
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const normalizedPrefix = prefix.trim();
  const membersByName = new Map(classStatement.members.map((member) => [member.name.name, member]));

  const pushItem = (item: CompletionItem): void => {
    if (normalizedPrefix.length > 0 && !item.label.startsWith(normalizedPrefix)) {
      return;
    }
    if (seen.has(item.label)) {
      return;
    }
    seen.add(item.label);
    items.push(item);
  };

  const memberNames = await resolveClassMemberNames(classStatement, objectTypeName, {
    ast: resolverContext.ast,
    options: resolverContext.options,
    cache: resolverContext.cache
  });
  for (const memberName of memberNames) {
    const resolved = await resolveClassMember(classStatement, memberName, objectTypeName, {
      ast: resolverContext.ast,
      options: resolverContext.options,
      analysis,
      cache: resolverContext.cache
    });
    if (!resolved) {
      continue;
    }
    if (resolved.kind === "field") {
      pushItem({
        label: memberName,
        kind: CompletionItemKind.Field,
        detail: `Class property: ${resolved.typeName}`,
        sortText: `${memberSortGroup(memberName, classStatement, membersByName)}-${memberName}`
      });
      continue;
    }

    const operatorSymbol = operatorSymbolFromMemberName(memberName);
    pushItem({
      label: memberName,
      kind: CompletionItemKind.Method,
      ...(operatorSymbol ? { filterText: memberName } : {}),
      detail: resolved.signature
        ? `Class method: (${resolved.signature.parameters.map((parameter) => `${parameter.name}: ${parameter.typeName}`).join(", ")}) => ${resolved.signature.returnTypeName}`
        : "Class method",
      ...(operatorSymbol && memberAccessEdit
        ? {
            textEdit: {
              range: {
                start: { line: memberAccessEdit.line, character: memberAccessEdit.dotCharacter + 1 },
                end: { line: memberAccessEdit.line, character: memberAccessEdit.prefixEndCharacter }
              },
              newText: ` ${operatorSymbol} `
            },
            additionalTextEdits: [
              {
                range: {
                  start: { line: memberAccessEdit.line, character: memberAccessEdit.dotCharacter },
                  end: { line: memberAccessEdit.line, character: memberAccessEdit.dotCharacter + 1 }
                },
                newText: ""
              }
            ]
          }
        : {}),
      sortText: `${memberSortGroup(memberName, classStatement, membersByName)}-${memberName}`
    });
  }

  return items;
}

export function buildInterfaceMemberCompletionItems(
  prefix: string,
  resolvedMembers: Array<InterfaceCompletionMember | TypeAliasCompletionMember>
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const normalizedPrefix = prefix.trim();
  for (const member of resolvedMembers) {
    if (normalizedPrefix.length > 0 && !member.name.startsWith(normalizedPrefix)) {
      continue;
    }
    if (seen.has(member.name)) {
      continue;
    }
    seen.add(member.name);
    items.push({
      label: member.name,
      kind: member.kind,
      detail: member.detail,
      sortText: `2-${member.name}`
    });
  }
  return items;
}

export function buildEnumMemberCompletionItems(
  enumStatement: EnumStatement,
  prefix: string
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const normalizedPrefix = prefix.trim();
  for (const member of enumStatement.members) {
    const label = member.name.name;
    if (normalizedPrefix.length > 0 && !label.startsWith(normalizedPrefix)) {
      continue;
    }
    items.push({
      label,
      kind: CompletionItemKind.EnumMember,
      detail: `Enum member: ${enumStatement.name.name}`,
      sortText: `2-${label}`
    });
  }
  return items;
}

export function typeAliasSubstitutions(
  typeAlias: TypeAliasStatement,
  objectTypeName: string
): Map<string, string> {
  const substitutions = new Map<string, string>();
  const parsedObjectType = parseTypeNameShape(objectTypeName);
  const declaredTypeParameters = typeAlias.typeParameters ?? [];
  for (let i = 0; i < declaredTypeParameters.length; i += 1) {
    const parameterName = declaredTypeParameters[i]?.name.name;
    if (!parameterName) {
      continue;
    }
    substitutions.set(parameterName, parsedObjectType.typeArguments[i] ?? parameterName);
  }
  return substitutions;
}

export function parseObjectTypeTextMembers(
  objectTypeText: string,
  substitutions: Map<string, string> = new Map()
): TypeAliasCompletionMember[] {
  const targetTypeText = objectTypeText.trim();
  if (!targetTypeText.startsWith("{") || !targetTypeText.endsWith("}")) {
    return [];
  }

  const body = targetTypeText.slice(1, -1).trim();
  if (body.length === 0) {
    return [];
  }

  const members: TypeAliasCompletionMember[] = [];

  const isCallableTypeText = (typeText: string): boolean =>
    splitTopLevelTypeText(typeText, "|").some((part) => {
      const trimmedPart = stripEnclosingTypeParens(part.trim());
      const parameterStart = findTopLevelTypeCharacter(trimmedPart, "(");
      if (parameterStart !== 0) {
        return false;
      }
      const parameterEnd = findMatchingTypeDelimiter(trimmedPart, parameterStart, "(", ")");
      if (parameterEnd < 0) {
        return false;
      }
      return trimmedPart.indexOf("=>", parameterEnd) >= 0;
    });

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
      const name = trimmedEntry.slice(0, methodOpenParen).trim().replace(/\?$/, "");
      if (!name) {
        continue;
      }
      members.push({
        name,
        kind: CompletionItemKind.Method,
        detail: `Type alias method: ${substituteTypeNameText(trimmedEntry.slice(methodOpenParen).trim(), substitutions)}`
      });
      continue;
    }

    if (propertyColon < 0) {
      continue;
    }
    const name = trimmedEntry.slice(0, propertyColon).trim().replace(/\?$/, "");
    if (!name) {
      continue;
    }
    const propertyTypeText = substituteTypeNameText(trimmedEntry.slice(propertyColon + 1).trim(), substitutions);
    members.push({
      name,
      kind: isCallableTypeText(propertyTypeText) ? CompletionItemKind.Method : CompletionItemKind.Field,
      detail: `${isCallableTypeText(propertyTypeText) ? "Type alias method" : "Type alias property"}: ${propertyTypeText}`
    });
  }

  return members;
}

export function parseTypeAliasObjectMembers(
  typeAlias: TypeAliasStatement,
  objectTypeName: string
): TypeAliasCompletionMember[] {
  return parseObjectTypeTextMembers(
    typeAlias.targetType.name,
    typeAliasSubstitutions(typeAlias, objectTypeName)
  );
}

export function findIdentifierAtPosition(
  ast: Program,
  line: number,
  character: number
): Identifier | null {
  let best: { identifier: Identifier; size: number } | undefined;
  walkAst(ast, (node) => {
    if (node.kind !== "Identifier") {
      return;
    }
    const identifier = node as Identifier;
    const range = nodeRange(identifier);
    if (!range || !containsPosition(range, { line, character })) {
      return;
    }
    const size = rangeSize(range);
    if (!best || size < best.size) {
      best = { identifier, size };
    }
  });
  return best ? best.identifier : null;
}

export function inferClassNameFromAstVariableInitializer(
  ast: Program,
  variableName: string,
  line: number
): string | null {
  let bestLine = -1;
  let bestClassName: string | null = null;

  const maybeClassNameFromInitializer = (initializer: Expr | undefined): string | null => {
    if (!initializer || initializer.kind !== "NewExpression") {
      return null;
    }
    const newExpression = initializer as Expr & { kind: "NewExpression"; callee: Expr };
    if (newExpression.callee.kind === "Identifier") {
      return (newExpression.callee as Expr & { kind: "Identifier"; name: string }).name;
    }
    return null;
  };

  const considerDeclaration = (
    name: string,
    initializer: Expr | undefined,
    declarationLine: number
  ): void => {
    if (name !== variableName || declarationLine > line) {
      return;
    }
    const className = maybeClassNameFromInitializer(initializer);
    if (!className) {
      return;
    }
    if (declarationLine >= bestLine) {
      bestLine = declarationLine;
      bestClassName = className;
    }
  };

  walkAst(ast, (node) => {
    if (node.kind !== "VarStatement") {
      return;
    }
    const varStatement = node as VarStatement;
    if (varStatement.declarations && varStatement.declarations.length > 0) {
      for (const declaration of varStatement.declarations) {
        for (const identifier of bindingIdentifiers(declaration.name)) {
          const declarationLine = identifier.firstToken?.range.start.line ?? -1;
          considerDeclaration(identifier.name, declaration.initializer, declarationLine);
        }
      }
    } else {
      for (const identifier of bindingIdentifiers(varStatement.name)) {
        const declarationLine = identifier.firstToken?.range.start.line ?? -1;
        considerDeclaration(identifier.name, varStatement.initializer, declarationLine);
      }
    }
  });

  return bestClassName;
}

export function inferTypeNameFromAstBindingAnnotation(
  ast: Program,
  bindingName: string,
  line: number
): string | null {
  let bestLine = -1;
  let bestTypeName: string | null = null;

  const typeNameFromAnnotation = (typeAnnotation: TypeAnnotation | undefined): string | null => {
    if (!typeAnnotation) {
      return null;
    }
    if (typeAnnotation.kind === "Identifier") {
      return typeAnnotation.name;
    }
    if (typeAnnotation.kind === "TypeReference") {
      return typeAnnotation.name.name;
    }
    return null;
  };

  const considerDeclaration = (
    name: string,
    typeAnnotation: TypeAnnotation | undefined,
    declarationLine: number
  ): void => {
    if (name !== bindingName || declarationLine > line) {
      return;
    }
    const typeName = typeNameFromAnnotation(typeAnnotation);
    if (!typeName) {
      return;
    }
    if (declarationLine >= bestLine) {
      bestLine = declarationLine;
      bestTypeName = typeName;
    }
  };

  walkAst(ast, (node) => {
    if (node.kind === "FunctionParameter") {
      const parameter = node as FunctionParameter;
      for (const identifier of bindingIdentifiers(parameter.name)) {
        const declarationLine = identifier.firstToken?.range.start.line ?? -1;
        considerDeclaration(identifier.name, parameter.typeAnnotation, declarationLine);
      }
      return;
    }
    if (node.kind !== "VarStatement") {
      return;
    }
    const varStatement = node as VarStatement;
    if (varStatement.declarations && varStatement.declarations.length > 0) {
      for (const declaration of varStatement.declarations) {
        for (const identifier of bindingIdentifiers(declaration.name)) {
          const declarationLine = identifier.firstToken?.range.start.line ?? -1;
          considerDeclaration(identifier.name, declaration.typeAnnotation, declarationLine);
        }
      }
    } else {
      for (const identifier of bindingIdentifiers(varStatement.name)) {
        const declarationLine = identifier.firstToken?.range.start.line ?? -1;
        considerDeclaration(identifier.name, varStatement.typeAnnotation, declarationLine);
      }
    }
  });

  return bestTypeName;
}

export async function resolveTypeNameFromPath(
  ast: Program,
  analysis: Analysis,
  pathSegments: string[],
  line: number,
  objectStartCharacter: number,
  resolverOptions: ClassResolverOptions,
  resolverCache: ClassResolverCache
): Promise<string | null> {
  if (pathSegments.length === 0) {
    return null;
  }

  const typeNameFromSymbol = (symbol: AnalysisSymbol): string | null => {
    if (symbol.valueType && symbol.valueType !== "unknown") {
      return symbol.valueType;
    }
    if (symbol.type) {
      return typeToString(symbol.type);
    }
    return null;
  };

  const identifierAtCursor = pathSegments.length === 1
    ? findIdentifierAtPosition(ast, line, objectStartCharacter)
    : null;
  if (identifierAtCursor) {
    const expressionTypeName = analysis.getExpressionTypes().get(identifierAtCursor)
      ? typeToString(analysis.getExpressionTypes().get(identifierAtCursor)!)
      : null;
    const narrowedExpressionTypeName = nonNullishTypeName(expressionTypeName);
    if (narrowedExpressionTypeName && narrowedExpressionTypeName !== "unknown") {
      return narrowedExpressionTypeName;
    }
    const annotatedTypeName = inferTypeNameFromAstBindingAnnotation(ast, identifierAtCursor.name, line);
    if (annotatedTypeName) {
      return annotatedTypeName;
    }
  }

  const symbolMatch = analysis.getSymbolAt(line, Math.max(0, objectStartCharacter));
  let currentTypeName: string | null = null;
  const firstSegment = pathSegments[0];
  if (!firstSegment) {
    return null;
  }
  const literalTypeName = inferLiteralTypeName(firstSegment);
  if (literalTypeName) {
    currentTypeName = literalTypeName;
  }
  if (!currentTypeName) {
    const resolvedSymbolMatch = symbolMatch;
    if (resolvedSymbolMatch && resolvedSymbolMatch.symbol.name === firstSegment) {
      currentTypeName = typeNameFromSymbol(resolvedSymbolMatch.symbol);
    } else {
      const visibleSymbols = analysis.getVisibleSymbolsAt(line, objectStartCharacter);
      const symbol = visibleSymbols.find((candidate) => candidate.name === firstSegment);
      if (!symbol) {
        currentTypeName =
          inferTypeNameFromAstBindingAnnotation(ast, firstSegment, line) ??
          inferClassNameFromAstVariableInitializer(ast, firstSegment, line);
        if (!currentTypeName) {
          return null;
        }
      } else {
        currentTypeName = typeNameFromSymbol(symbol);
      }
    }
  }

  currentTypeName = nonNullishTypeName(currentTypeName);
  if (!currentTypeName || currentTypeName === "unknown") {
    currentTypeName =
      inferTypeNameFromAstBindingAnnotation(ast, firstSegment, line) ??
      inferClassNameFromAstVariableInitializer(ast, firstSegment, line);
  }
  for (let index = 1; index < pathSegments.length; index += 1) {
    const memberName = pathSegments[index];
    if (!memberName || !currentTypeName) {
      return null;
    }
    currentTypeName = boxedCompletionTypeName(currentTypeName);
    if (!currentTypeName) {
      return null;
    }
    const classResolution = await resolveClassStatementAcrossFiles(
      ast,
      baseTypeName(currentTypeName),
      resolverOptions,
      resolverCache
    );
    if (!classResolution) {
      const interfaceStatement = (await resolveInterfaceStatementAcrossFiles(
        ast,
        baseTypeName(currentTypeName),
        resolverOptions,
        resolverCache
      ))?.interfaceStatement;
      if (interfaceStatement) {
        const member = await resolveInterfaceMember(interfaceStatement, memberName, currentTypeName, {
          ast,
          options: resolverOptions,
          cache: resolverCache
        });
        if (member) {
          currentTypeName = member.kind === "method"
            ? member.signature?.returnTypeName ?? null
            : member.typeName;
          continue;
        }
      }
      currentTypeName = await resolveExtensionMemberTypeName(
        ast,
        currentTypeName,
        memberName,
        {
          ...resolverOptions
        },
        analysis
      );
      if (!currentTypeName) {
        return null;
      }
      continue;
    }
    const member = await resolveClassMember(classResolution.classStatement, memberName, currentTypeName, {
      ast,
      options: resolverOptions,
      analysis,
      cache: resolverCache
    });
    if (!member) {
      currentTypeName = await resolveExtensionMemberTypeName(
        ast,
        currentTypeName,
        memberName,
        {
          ...resolverOptions
        },
        analysis
      );
      if (!currentTypeName) {
        return null;
      }
      continue;
    }
    if (member.kind === "method") {
      currentTypeName = member.signature?.returnTypeName ?? null;
    } else {
      currentTypeName = member.typeName;
    }
  }

  return currentTypeName;
}

export async function findNodeModuleNamespaceForTypeName(
  ast: Program,
  typeName: string,
  importerFilePath: string,
  options: CompletionRequestOptions
): Promise<NamespaceStatement | null> {
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") continue;
    const importStatement = statement as ImportStatement;
    if (importStatement.from.value.startsWith(".")) continue;
    const typings = await getNodeModuleTypings(importerFilePath, importStatement.from.value, { vfs: options.vfs });
    if (!typings || typings.defaultExportName !== typeName) continue;
    for (const decl of typings.declarations) {
      const candidate =
        decl.kind === "ExportStatement"
          ? (decl as { declaration?: Statement }).declaration ?? decl
          : decl;
      if (
        candidate.kind === "NamespaceStatement" &&
        (candidate as NamespaceStatement).names?.[0]?.name === typeName
      ) {
        return candidate as NamespaceStatement;
      }
    }
  }
  return null;
}

export function findNamespaceByPath(ast: Program, path: string[]): NamespaceStatement | null {
  let statements: Statement[] = ast.body;
  let found: NamespaceStatement | null = null;
  for (const segment of path) {
    found = null;
    for (const statement of statements) {
      const candidate = statement.kind === "ExportStatement" ? (statement as ExportStatement).declaration : statement;
      if (candidate?.kind === "NamespaceStatement" && (candidate as NamespaceStatement).names?.[0]?.name === segment) {
        found = candidate as NamespaceStatement;
        break;
      }
    }
    if (!found) return null;
    statements = found.body.body;
  }
  return found;
}

export function buildNamespaceMemberCompletionItems(namespaceStatement: NamespaceStatement, prefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const push = (label: string, kind: CompletionItemKind, detail: string): void => {
    if (!label.startsWith(prefix) || seen.has(label)) return;
    seen.add(label);
    items.push({ label, kind, detail });
  };
  for (const statement of namespaceStatement.body.body) {
    if (statement.kind !== "ExportStatement") continue;
    const exported = statement as ExportStatement;
    const declaration = exported.declaration;
    if (declaration?.kind === "VarStatement") {
      const variable = declaration as VarStatement;
      const bindings = variable.declarations?.flatMap((item) => bindingIdentifiers(item.name)) ?? bindingIdentifiers(variable.name);
      for (const binding of bindings) push(binding.name, CompletionItemKind.Variable, "Namespace variable");
    } else if (declaration?.kind === "FunctionStatement") {
      push((declaration as FunctionStatement).name.name, CompletionItemKind.Function, "Namespace function");
    } else if (declaration?.kind === "ClassStatement") {
      push((declaration as ClassStatement).name.name, CompletionItemKind.Class, "Namespace class");
    } else if (declaration?.kind === "NamespaceStatement") {
      const name = (declaration as NamespaceStatement).names?.[0]?.name;
      if (name) push(name, CompletionItemKind.Module, "Namespace");
    }
    for (const specifier of exported.specifiers ?? []) push(specifier.exported.name, CompletionItemKind.Variable, "Namespace export");
  }
  return items;
}

export async function buildMemberCompletionItemsForType(
  ast: Program,
  analysis: Analysis,
  className: string,
  prefix: string,
  line: number,
  dotCharacter: number,
  prefixEndCharacter: number,
  options: CompletionRequestOptions,
  resolverOptions: ClassResolverOptions,
  resolverCache: ClassResolverCache
): Promise<CompletionItem[]> {
  // Array types (`T[]`) resolve their members from the declared `class Array<T>`.
  const narrowedClassName = boxedCompletionTypeName(className);
  const resolvedClassName = arrayTypeNameToArrayAlias(narrowedClassName) ?? narrowedClassName;
  const classStatement = (await resolveClassStatementAcrossFiles(
    ast,
    baseTypeName(resolvedClassName),
    resolverOptions,
    resolverCache
  ))?.classStatement;
  const enumStatement = (await resolveTopLevelDeclarationAcrossFiles({
    ast,
    name: baseTypeName(resolvedClassName),
    currentFilePath: options.uri ? fileURLToPath(options.uri) : null,
    predicate: (statement): statement is EnumStatement => statement.kind === "EnumStatement",
    includeRuntime: true,
    sourceRoots: resolverOptions.sourceRoots ?? [],
    ...(resolverOptions.vfs ? { vfs: resolverOptions.vfs } : {}),
    ...(resolverOptions.getSessionForFilePath
      ? { getSessionForFilePath: resolverOptions.getSessionForFilePath }
      : {})
  }))?.declaration;
  const interfaceStatement = (await resolveInterfaceStatementAcrossFiles(
    ast,
    baseTypeName(resolvedClassName),
    resolverOptions,
    resolverCache
  ))?.interfaceStatement;
  const interfaceMembers: InterfaceCompletionMember[] = interfaceStatement
    ? (await Promise.all(
      (await resolveInterfaceMemberNames(
        interfaceStatement,
        resolvedClassName,
        {
          ast,
          options: resolverOptions,
          cache: resolverCache
        }
      )).map(async (memberName) => {
        const member = await resolveInterfaceMember(interfaceStatement, memberName, resolvedClassName, {
          ast,
          options: resolverOptions,
          cache: resolverCache
        });
        if (!member) {
          return null;
        }
        return {
          name: memberName,
          kind: member.kind === "field" ? CompletionItemKind.Field : CompletionItemKind.Method,
          detail: member.kind === "field"
            ? `Interface property: ${member.typeName}`
            : `Interface method: ${member.typeName}`
        };
      })
    )).filter((member): member is InterfaceCompletionMember => member !== null)
    : [];
  const ambientInterfaceMembers = !interfaceStatement && options.ambientDeclarations
    ? collectAmbientInterfaceCompletionMembers(options.ambientDeclarations, baseTypeName(resolvedClassName))
    : [];
  const typeAliasStatement = (await resolveTopLevelDeclarationAcrossFiles({
    ast,
    name: baseTypeName(resolvedClassName),
    currentFilePath: options.uri ? fileURLToPath(options.uri) : null,
    predicate: (statement): statement is TypeAliasStatement => statement.kind === "TypeAliasStatement",
    includeRuntime: true,
    sourceRoots: resolverOptions.sourceRoots ?? [],
    ...(resolverOptions.vfs ? { vfs: resolverOptions.vfs } : {}),
    ...(resolverOptions.getSessionForFilePath
      ? { getSessionForFilePath: resolverOptions.getSessionForFilePath }
      : {})
  }))?.declaration;
  const typeAliasMembers = typeAliasStatement
    ? parseTypeAliasObjectMembers(typeAliasStatement, resolvedClassName)
    : [];
  const objectTypeMembers = parseObjectTypeTextMembers(resolvedClassName);
  return [
    ...await buildExtensionMemberCompletionItems(ast, className, prefix, options, analysis),
    ...(classStatement
        ? await buildClassMemberCompletionItems(
        classStatement,
        resolvedClassName,
        prefix,
        analysis,
        {
          line,
          dotCharacter,
            prefixEndCharacter
          },
          {
            ast,
            options: resolverOptions,
            cache: resolverCache
          }
        )
      : enumStatement
        ? buildEnumMemberCompletionItems(enumStatement, prefix)
      : interfaceStatement
        ? buildInterfaceMemberCompletionItems(prefix, interfaceMembers)
        : ambientInterfaceMembers.length > 0
          ? buildInterfaceMemberCompletionItems(prefix, ambientInterfaceMembers)
        : typeAliasMembers.length > 0
          ? buildInterfaceMemberCompletionItems(prefix, typeAliasMembers)
          : objectTypeMembers.length > 0
            ? buildInterfaceMemberCompletionItems(prefix, objectTypeMembers)
          : [])
  ];
}

export async function buildMemberAccessCompletions(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions,
  allowRecovery = true
): Promise<CompletionItem[] | null> {
  const resolverOptions = classResolverOptionsFromCompletionOptions(options);
  const resolverCache = createClassResolverCache();

  const target = parseMemberAccessTarget(options.text, line, character);
  if (target) {
    const pathSegments = target.objectPath.split(".");
    if (pathSegments.length > 1 && pathSegments[0]) {
      const firstSegmentEnum = (await resolveTopLevelDeclarationAcrossFiles({
        ast,
        name: pathSegments[0],
        currentFilePath: options.uri ? fileURLToPath(options.uri) : null,
        predicate: (statement): statement is EnumStatement => statement.kind === "EnumStatement",
        includeRuntime: true,
        sourceRoots: resolverOptions.sourceRoots ?? [],
        ...(resolverOptions.vfs ? { vfs: resolverOptions.vfs } : {}),
        ...(resolverOptions.getSessionForFilePath
          ? { getSessionForFilePath: resolverOptions.getSessionForFilePath }
          : {})
      }))?.declaration;
      if (firstSegmentEnum) {
        return [];
      }
    }
    const importerFilePath = options.uri ? fileURLToPath(options.uri) : null;
    const namespaceStatement =
      findNamespaceByPath(ast, pathSegments) ??
      (importerFilePath && pathSegments.length === 1 && pathSegments[0]
        ? await findNodeModuleNamespaceForTypeName(ast, pathSegments[0], importerFilePath, options)
        : null);
    if (namespaceStatement) {
      return buildNamespaceMemberCompletionItems(namespaceStatement, target.prefix);
    }
    const className = await resolveTypeNameFromPath(
      ast,
      analysis,
      pathSegments,
      line,
      target.objectStartCharacter,
      resolverOptions,
      resolverCache
    );
    if (className) {
      const items = await buildMemberCompletionItemsForType(
        ast,
        analysis,
        className,
        target.prefix,
        line,
        target.memberAccessStartCharacter,
        character,
        options,
        resolverOptions,
        resolverCache
      );
      if (items.length > 0 || !allowRecovery) {
        return items;
      }
      return buildRecoveredMemberAccessCompletions(line, character, options);
    }
  }

  // The receiver is a complex expression (such as a call like `fetch(...)`) or
  // identifier-based resolution failed. Resolve its type from the analyzed
  // expression types, which already reflect sync-function auto-await
  // (`Promise<T>` is observed as `T`).
  const dot = findMemberAccessDot(options.text, line, character);
  if (dot) {
    const receiverTypeName = receiverTypeNameEndingAt(analysis, line, dot.receiverEndCharacter);
    if (receiverTypeName && receiverTypeName !== "unknown") {
      const items = await buildMemberCompletionItemsForType(
        ast,
        analysis,
        receiverTypeName,
        dot.prefix,
        line,
        dot.dotCharacter,
        character,
        options,
        resolverOptions,
        resolverCache
      );
      if (items.length > 0) {
        return items;
      }
    }
  }

  if (!target && !dot) {
    return null;
  }
  return allowRecovery ? buildRecoveredMemberAccessCompletions(line, character, options) : null;
}

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
  const prefixStartCharacter = "memberAccessStartCharacter" in target
    ? clampedCharacter - target.prefix.length
    : clampedCharacter - target.prefix.length;
  lines[line] =
    lineText.slice(0, prefixStartCharacter) +
    COMPLETION_RECOVERY_MEMBER +
    lineText.slice(clampedCharacter);
  return lines.join("\n");
}

export async function buildRecoveredMemberAccessCompletions(
  line: number,
  character: number,
  options: CompletionRequestOptions
): Promise<CompletionItem[] | null> {
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
      const items = await buildMemberCompletionItemsForType(
        recovered.ast,
        recovered.analysis,
        recoveredTypeName,
        dot.prefix,
        line,
        dot.dotCharacter,
        character,
        {
          ...options,
          text: recoveredSource
        },
        resolverOptions,
        resolverCache
      );
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
