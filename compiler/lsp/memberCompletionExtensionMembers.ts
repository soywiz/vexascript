import { buildExtensionAutoImportSuggestions } from "./importFixes";
import { Analysis } from "compiler/analysis/Analysis";
import { baseTypeName } from "compiler/analysis/typeNames";
import {
  createClassResolverCache,
  resolveClassStatementAcrossFiles,
  resolveInterfaceStatementAcrossFiles,
  type ClassResolverCache
} from "./classResolver";
import type {
  ExportStatement,
  FunctionStatement,
  ImportStatement,
  Program,
  Statement,
  VarStatement
} from "compiler/ast/ast";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import { fileURLToPath } from "compiler/utils/path";
import type { CompletionItem } from "vscode-languageserver/node.js";
import {
  CompletionItemKind,
  matchesCompletionPrefix,
  type CompletionRequestOptions,
  type ExtensionMemberCompletionCandidate
} from "./completionModel";
import {
  extensionBindingNames,
  extensionReceiverMatches,
  inferExtensionReturnTypeName
} from "./memberCompletionExtensions";

async function extensionReceiverMatchesResolvedType(
  ast: Program,
  receiverType: string,
  objectTypeName: string,
  options: CompletionRequestOptions,
  resolverCache: ClassResolverCache
): Promise<boolean> {
  if (extensionReceiverMatches(receiverType, objectTypeName)) {
    return true;
  }

  const resolverOptions = {
    ...(options.uri ? { uri: options.uri } : {}),
    ...(options.sourceRoots ? { sourceRoots: options.sourceRoots } : {}),
    ...(options.vfs ? { vfs: options.vfs } : {}),
    ...(options.ambientModuleDeclarations
      ? { ambientModuleDeclarations: options.ambientModuleDeclarations }
      : {}),
    ...(options.getSessionForFilePath
      ? { getSessionForFilePath: options.getSessionForFilePath }
      : {})
  };
  const normalizedObjectTypeName = baseTypeName(objectTypeName);
  const seen = new Set<string>();

  const matchesHierarchy = async (typeName: string): Promise<boolean> => {
    const normalizedTypeName = baseTypeName(typeName);
    if (!normalizedTypeName || seen.has(normalizedTypeName)) {
      return false;
    }
    seen.add(normalizedTypeName);

    if (extensionReceiverMatches(receiverType, normalizedTypeName)) {
      return true;
    }

    const classResolution = await resolveClassStatementAcrossFiles(
      ast,
      normalizedTypeName,
      resolverOptions,
      resolverCache
    );
    if (classResolution) {
      const classStatement = classResolution.classStatement;
      if (classStatement.extendsType && await matchesHierarchy(classStatement.extendsType.name)) {
        return true;
      }
      for (const implemented of classStatement.implementsTypes ?? []) {
        if (await matchesHierarchy(implemented.name)) {
          return true;
        }
      }
    }

    const interfaceResolution = await resolveInterfaceStatementAcrossFiles(
      ast,
      normalizedTypeName,
      resolverOptions,
      resolverCache
    );
    if (interfaceResolution) {
      for (const parent of interfaceResolution.interfaceStatement.extendsTypes ?? []) {
        if (await matchesHierarchy(parent.name)) {
          return true;
        }
      }
    }

    return false;
  };

  return matchesHierarchy(normalizedObjectTypeName);
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
  const resolverCache = createClassResolverCache();

  const maybePushStatement = async (
    statement: Statement,
    statementAnalysis: Analysis | null,
    visibleImportedNames?: ReadonlySet<string>
  ): Promise<void> => {
    const candidate = statement.kind === "ExportStatement"
      ? (statement as ExportStatement).declaration
      : statement;
    if (!candidate) {
      return;
    }
    if (candidate.kind === "VarStatement") {
      const variable = candidate as VarStatement;
      const receiverType = variable.receiverType?.name;
      if (!receiverType || !(await extensionReceiverMatchesResolvedType(ast, receiverType, objectTypeName, options, resolverCache))) {
        return;
      }
      for (const bindingName of extensionBindingNames(variable)) {
        if (visibleImportedNames && !visibleImportedNames.has(bindingName)) {
          continue;
        }
        if (seen.has(`property:${bindingName}`)) {
          continue;
        }
        seen.add(`property:${bindingName}`);
        candidates.push({
          name: bindingName,
          receiverType,
          kind: "property",
          returnTypeName: inferExtensionReturnTypeName(variable, statementAnalysis)
        });
      }
      return;
    }
    if (candidate.kind === "FunctionStatement") {
      const fn = candidate as FunctionStatement;
      const receiverType = fn.receiverType?.name;
      if (
        !receiverType
        || fn.operator
        || !(await extensionReceiverMatchesResolvedType(ast, receiverType, objectTypeName, options, resolverCache))
      ) {
        return;
      }
      if (visibleImportedNames && !visibleImportedNames.has(fn.name.name)) {
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
        returnTypeName: inferExtensionReturnTypeName(fn, statementAnalysis)
      });
    }
  };

  for (const statement of ast.body) {
    await maybePushStatement(statement, analysis);
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
      await maybePushStatement(importedStatement, importedAnalysis, importedNames);
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
    if (!matchesCompletionPrefix(item.label, normalizedPrefix)) {
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
