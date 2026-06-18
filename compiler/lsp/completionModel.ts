/**
 * Shared completion model: LSP completion item kinds/formats/commands, the
 * keyword fallback list, request-option contracts shared by every completion
 * strategy, and small item helpers such as call-snippet decoration.
 */
import type { ClassResolverOptions } from "./classResolver";
import type { SymbolExportProvider } from "./importFixes";
import { Analysis } from "compiler/analysis/Analysis";
import type { AnalysisSymbol } from "compiler/analysis/Analysis";
import type { Program, Statement } from "compiler/ast/ast";
import type { Vfs } from "compiler/vfs";
import type { CompletionItem } from "vscode-languageserver/node.js";

export const CompletionItemKind = {
  Text: 1,
  Method: 2,
  Function: 3,
  Constructor: 4,
  Field: 5,
  Variable: 6,
  Class: 7,
  Interface: 8,
  Module: 9,
  Property: 10,
  Unit: 11,
  Value: 12,
  Enum: 13,
  Keyword: 14,
  Snippet: 15,
  Color: 16,
  File: 17,
  Reference: 18,
  Folder: 19,
  EnumMember: 20,
  Constant: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;

export type CompletionItemKind = (typeof CompletionItemKind)[keyof typeof CompletionItemKind];

export type InterfaceCompletionMember = {
  name: string;
  detail: string;
  kind: typeof CompletionItemKind.Field | typeof CompletionItemKind.Method;
};

export type TypeAliasCompletionMember = {
  name: string;
  detail: string;
  kind: typeof CompletionItemKind.Field | typeof CompletionItemKind.Method;
};

function isCallableValueType(valueType: string | undefined): boolean {
  if (!valueType) {
    return false;
  }
  return valueType.trim().startsWith("(") && valueType.includes("=>");
}

export const KEYWORD_COMPLETIONS: CompletionItem[] = [
  { label: "fn", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "type", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "annotation", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "interface", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "enum", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "namespace", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "module", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "declare", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "debugger", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "int", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "number", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "numeric", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "bigint", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "long", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "string", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "boolean", kind: CompletionItemKind.Keyword, detail: "Builtin type" }
];

export function symbolKindToCompletionKind(symbol: AnalysisSymbol): CompletionItemKind {
  if (symbol.kind === "function" || symbol.kind === "method" || isCallableValueType(symbol.valueType)) {
    return CompletionItemKind.Function;
  }
  if (symbol.kind === "class") {
    return CompletionItemKind.Class;
  }
  return CompletionItemKind.Variable;
}

export function symbolDetail(symbol: AnalysisSymbol): string {
  if (symbol.valueType) {
    return `In-scope ${symbol.kind}: ${symbol.valueType}`;
  }
  return `In-scope ${symbol.kind}`;
}

export interface CompletionSessionLike {
  ast: Program | null;
  analysis: Analysis | null;
}

export interface CompletionRequestOptions {
  text?: string;
  uri?: string;
  sourceRoots?: string[];
  ambientDeclarations?: Statement[];
  ambientModuleDeclarations?: ReadonlyMap<string, Statement[]>;
  vfs?: Vfs;
  getSessionForFilePath?: (filePath: string) => CompletionSessionLike | null | Promise<CompletionSessionLike | null>;
  getExportedSymbols?: SymbolExportProvider;
  recoverAnalysisSession?: (source: string) => CompletionSessionLike | Promise<CompletionSessionLike>;
}

export interface MemberAccessTarget {
  objectPath: string;
  objectStartCharacter: number;
  memberAccessStartCharacter: number;
  prefix: string;
}

export interface ExtensionMemberCompletionCandidate {
  name: string;
  receiverType: string;
  kind: "property" | "method";
  returnTypeName?: string | null;
}

export const COMPLETION_RECOVERY_MEMBER = "__vexa_completion__";

export const CompletionItemInsertTextFormat = {
  PlainText: 1,
  Snippet: 2,
} as const;

export const CompletionCommand = {
  TriggerParameterHints: "editor.action.triggerParameterHints",
} as const;

export function isCallableCompletionLabel(label: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(label);
}

export function withCallSnippet(item: CompletionItem): CompletionItem {
  if (item.insertText) {
    return item;
  }
  if (item.kind !== CompletionItemKind.Method && item.kind !== CompletionItemKind.Function) {
    return item;
  }
  if (!isCallableCompletionLabel(item.label)) {
    return item;
  }
  return {
    ...item,
    insertText: `${item.label}($1)`,
    insertTextFormat: CompletionItemInsertTextFormat.Snippet,
    command: {
      title: "Trigger parameter hints",
      command: CompletionCommand.TriggerParameterHints,
    },
  };
}

export function classResolverOptionsFromCompletionOptions(options: CompletionRequestOptions): ClassResolverOptions {
  return {
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
}

export function matchesCompletionPrefix(label: string, prefix: string): boolean {
  const normalizedPrefix = prefix.trim();
  if (normalizedPrefix.length === 0) {
    return true;
  }
  return label.toLocaleLowerCase().startsWith(normalizedPrefix.toLocaleLowerCase());
}
