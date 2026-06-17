/**
 * Member-access completion strategy: receiver detection and receiver-type
 * recovery around the cursor, cross-file class/interface/enum/type-alias
 * member item builders, extension-member completion, and namespace member
 * completion. Orchestrated by createCompletionItemsForPosition in
 * completion.ts.
 */
import { classPropertyParameters, createClassResolverCache, resolveClassMember, resolveClassMemberNames, resolveClassStatementAcrossFiles, resolveInterfaceMember, resolveInterfaceMemberNames, resolveInterfaceStatementAcrossFiles } from "./classResolver";
import type { ClassResolverCache, ClassResolverOptions } from "./classResolver";
import { COMPLETION_RECOVERY_MEMBER, CompletionItemKind, classResolverOptionsFromCompletionOptions } from "./completionModel";
import type { CompletionRequestOptions, ExtensionMemberCompletionCandidate, InterfaceCompletionMember, TypeAliasCompletionMember } from "./completionModel";
import { resolveTopLevelDeclarationAcrossFiles } from "./declarationResolver";
import { buildExtensionAutoImportSuggestions } from "./importFixes";
import { getNodeModuleTypings } from "./nodeModulesTypings";
import { Analysis } from "compiler/analysis/Analysis";
import { baseTypeName } from "compiler/analysis/typeNames";
import type { ClassMember, ClassStatement, EnumStatement, ExportStatement, FunctionStatement, ImportStatement, InterfaceStatement, NamespaceStatement, Program, Statement, TypeAliasStatement, VarStatement } from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import { compileSource } from "compiler/pipeline/compile";
import { fileURLToPath } from "compiler/utils/path";
import type { CompletionItem } from "vscode-languageserver/node.js";
import {
  extensionBindingNames,
  extensionReceiverMatches,
  inferExtensionReturnTypeName
} from "./memberCompletionExtensions";
import {
  findMemberAccessDot,
  parseMemberAccessTarget
} from "./memberCompletionParsing";
import {
  parseObjectTypeTextMembers,
  parseTypeAliasObjectMembers
} from "./memberCompletionObjectMembers";
import { resolveTypeNameFromPath } from "./memberCompletionPathTypes";
import {
  arrayTypeNameToArrayAlias,
  boxedCompletionTypeName,
  recoveredReceiverTypeName,
  receiverTypeNameEndingAt
} from "./memberCompletionTypeNames";

export function operatorSymbolFromMemberName(name: string): string | null {
  return name.startsWith("operator") ? name.slice("operator".length) || null : null;
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
      for (const bindingName of extensionBindingNames(variable)) {
        if (seen.has(`property:${bindingName}`)) {
          continue;
        }
        seen.add(`property:${bindingName}`);
        candidates.push({
          name: bindingName,
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
        for (const bindingName of extensionBindingNames(variable)) {
          if (!importedNames.has(bindingName) || seen.has(`property:${bindingName}`)) {
            continue;
          }
          seen.add(`property:${bindingName}`);
          candidates.push({
            name: bindingName,
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
      resolverCache,
      resolveExtensionMemberTypeName
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
