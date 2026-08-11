import { ClassMethodMember, ClassStatement, FunctionStatement, InterfaceMethodMember, InterfaceStatement, NamespaceStatement, VarStatement } from "compiler/ast/ast";
import type { Identifier, Program } from "compiler/ast/ast";

import { declarationIndexForStatements } from "compiler/analysis/declarationIndex";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { containsPosition, nodeRange } from "./ranges";
import {
  getEcmaScriptRuntimeProgram,
  getVexaScriptRuntimeProgram
} from "compiler/runtime/ecmascriptDeclarations";
import type { CompletionItem } from "vscode-languageserver/node.js";
import {
  CompletionCommand,
  CompletionItemInsertTextFormat,
  CompletionItemKind
} from "./completionModel";

function collectAvailableAnnotations(program: Program) {
  const byName = new Map<string, import("compiler/ast/ast").AnnotationStatement>();
  for (const statement of declarationIndexForStatements(getVexaScriptRuntimeProgram().body).annotations) {
    byName.set(statement.name.name, statement);
  }
  for (const statement of declarationIndexForStatements(getEcmaScriptRuntimeProgram().body).annotations) {
    byName.set(statement.name.name, statement);
  }
  for (const statement of declarationIndexForStatements(program.body).annotations) {
    byName.set(statement.name.name, statement);
  }
  return [...byName.values()].sort((left, right) => left.name.name.localeCompare(right.name.name));
}

export function annotationPrefixAtPosition(
  text: string | undefined,
  line: number,
  character: number
): string | null {
  if (!text) {
    return null;
  }
  const lineText = text.split("\n")[line] ?? "";
  const uptoCursor = lineText.slice(0, Math.max(0, Math.min(character, lineText.length)));
  const match = /@([A-Za-z_][A-Za-z0-9_]*)?$/u.exec(uptoCursor);
  return match ? match[1] ?? "" : null;
}

export function annotationCompletionItems(program: Program, prefix: string): CompletionItem[] {
  const normalizedPrefix = prefix.trim();
  const items: CompletionItem[] = [];
  for (const annotation of collectAvailableAnnotations(program)) {
    const label = annotation.name.name;
    if (normalizedPrefix.length > 0 && !label.startsWith(normalizedPrefix)) {
      continue;
    }
    items.push({
      label,
      kind: CompletionItemKind.Function,
      detail: "Annotation",
      ...(annotation.parameters.length > 0
        ? {
            insertText: `${label}($1)`,
            insertTextFormat: CompletionItemInsertTextFormat.Snippet,
            command: {
              title: "Trigger parameter hints",
              command: CompletionCommand.TriggerParameterHints,
            }
          }
        : {
            insertText: label
          }),
      sortText: `0-${label}`
    });
  }
  return items;
}

interface JsxBlockCompletionContext {
  kind: "open" | "branch" | "close";
  prefix: string;
  editStartCharacter: number;
}

function jsxBlockCompletionContextAtPosition(
  text: string | undefined,
  line: number,
  character: number
): JsxBlockCompletionContext | null {
  if (!text) {
    return null;
  }

  const lineText = text.split("\n")[line] ?? "";
  const uptoCursor = lineText.slice(0, Math.max(0, Math.min(character, lineText.length)));
  const open = /\{#([A-Za-z]*)$/u.exec(uptoCursor);
  if (open) {
    return { kind: "open", prefix: open[1] ?? "", editStartCharacter: open.index + 2 };
  }
  const branch = /\{:\s*([A-Za-z]*(?:\s+[A-Za-z]*)?)$/u.exec(uptoCursor);
  if (branch) {
    return { kind: "branch", prefix: branch[1] ?? "", editStartCharacter: branch.index + 2 };
  }
  const close = /\{\/([A-Za-z]*)$/u.exec(uptoCursor);
  if (close) {
    return { kind: "close", prefix: close[1] ?? "", editStartCharacter: close.index + 2 };
  }
  return null;
}

export function jsxBlockCompletionItemsAtPosition(
  text: string | undefined,
  line: number,
  character: number
): CompletionItem[] | null {
  const context = jsxBlockCompletionContextAtPosition(text, line, character);
  if (!context) {
    return null;
  }

  const candidates = context.kind === "open"
    ? [
        {
          label: "for block",
          filterText: "for",
          detail: "JSX for block",
          insertText: "for ${1:item} of ${2:items}}\n  $0\n{/for}"
        },
        {
          label: "if block",
          filterText: "if",
          detail: "JSX if block",
          insertText: "if ${1:condition}}\n  $0\n{/if}"
        }
      ]
    : context.kind === "branch"
      ? [
          {
            label: "else branch",
            filterText: "else",
            detail: "JSX else branch",
            insertText: "else}\n  $0"
          },
          {
            label: "else if branch",
            filterText: "else if",
            detail: "JSX else-if branch",
            insertText: "else if ${1:condition}}\n  $0"
          }
        ]
      : [
          {
            label: "close for block",
            filterText: "for",
            detail: "Close JSX for block",
            insertText: "for}"
          },
          {
            label: "close if block",
            filterText: "if",
            detail: "Close JSX if block",
            insertText: "if}"
          }
        ];
  const normalizedPrefix = context.prefix.trim().replace(/\s+/gu, " ").toLocaleLowerCase();

  return candidates
    .filter((candidate) => candidate.filterText.startsWith(normalizedPrefix))
    .map(({ insertText, ...candidate }, index) => ({
      ...candidate,
      kind: CompletionItemKind.Snippet,
      insertTextFormat: CompletionItemInsertTextFormat.Snippet,
      textEdit: {
        range: {
          start: { line, character: context.editStartCharacter },
          end: { line, character }
        },
        newText: insertText
      },
      sortText: `0-jsx-block-${String(index).padStart(2, "0")}`
    }));
}

function declarationNameRangeContainsPosition(identifier: Identifier, line: number, character: number): boolean {
  const range = nodeRange(identifier);
  return !!range && containsPosition(range, { line, character });
}

function isTextualDeclarationNamePosition(
  text: string | undefined,
  line: number,
  character: number
): boolean {
  if (!text) {
    return false;
  }

  const lineText = text.split("\n")[line] ?? "";
  const clampedCharacter = Math.max(0, Math.min(character, lineText.length));
  const uptoCursor = lineText.slice(0, clampedCharacter);

  return [
    /^\s*(?:fun|fn|func|function)\s+[A-Za-z_][A-Za-z0-9_]*$/u,
    /^\s*(?:let|val|var|const)\s+[A-Za-z_][A-Za-z0-9_]*$/u,
    /^\s*(?:class|interface|namespace)\s+[A-Za-z_][A-Za-z0-9_]*$/u,
  ].some((pattern) => pattern.test(uptoCursor));
}

function isDeclarationNamePosition(ast: Program, line: number, character: number): boolean {
  const matchesBinding = (identifier: Identifier): boolean =>
    declarationNameRangeContainsPosition(identifier, line, character);

  for (const statement of ast.body) {
    if (statement instanceof FunctionStatement) {
      const fn = statement as FunctionStatement;
      if (matchesBinding(fn.name)) {
        return true;
      }
      for (const parameter of fn.parameters) {
        for (const binding of bindingIdentifiers(parameter.name)) {
          if (matchesBinding(binding)) {
            return true;
          }
        }
      }
      continue;
    }

    if (statement instanceof VarStatement) {
      const variable = statement as VarStatement;
      const bindings = variable.declarations?.flatMap((item) => bindingIdentifiers(item.name)) ?? bindingIdentifiers(variable.name);
      if (bindings.some(matchesBinding)) {
        return true;
      }
      continue;
    }

    if (statement instanceof ClassStatement) {
      const classStatement = statement as ClassStatement;
      if (matchesBinding(classStatement.name)) {
        return true;
      }
      for (const parameter of classStatement.primaryConstructorParameters ?? []) {
        for (const binding of bindingIdentifiers(parameter.name)) {
          if (matchesBinding(binding)) {
            return true;
          }
        }
      }
      for (const member of classStatement.members) {
        if (matchesBinding(member.name)) {
          return true;
        }
        if (member instanceof ClassMethodMember) {
          const method = member as ClassMethodMember;
          for (const parameter of method.parameters) {
            for (const binding of bindingIdentifiers(parameter.name)) {
              if (matchesBinding(binding)) {
                return true;
              }
            }
          }
        }
      }
      continue;
    }

    if (statement instanceof InterfaceStatement) {
      const interfaceStatement = statement as InterfaceStatement;
      if (matchesBinding(interfaceStatement.name)) {
        return true;
      }
      for (const member of interfaceStatement.members) {
        if (matchesBinding(member.name)) {
          return true;
        }
        if (member instanceof InterfaceMethodMember) {
          const method = member as InterfaceMethodMember;
          for (const parameter of method.parameters) {
            for (const binding of bindingIdentifiers(parameter.name)) {
              if (matchesBinding(binding)) {
                return true;
              }
            }
          }
        }
      }
      continue;
    }

    if (statement instanceof NamespaceStatement) {
      const namespaceStatement = statement as NamespaceStatement;
      if ((namespaceStatement.names ?? []).some((name) => matchesBinding(name))) {
        return true;
      }
    }
  }

  return false;
}

export function shouldSuppressExistingSymbolCompletions(
  ast: Program,
  line: number,
  character: number,
  text: string | undefined
): boolean {
  return (
    isDeclarationNamePosition(ast, line, character) ||
    isTextualDeclarationNamePosition(text, line, character)
  );
}
