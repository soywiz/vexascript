import type { ClassStatement, ExportStatement, FunctionStatement, ImportStatement, NamespaceStatement, Program, Statement, VarStatement } from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { getNodeModuleTypings } from "./nodeModulesTypings";
import { CompletionItemKind, type CompletionRequestOptions } from "./completionModel";
import type { CompletionItem } from "vscode-languageserver/node.js";

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
