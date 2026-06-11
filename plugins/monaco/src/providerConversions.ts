import type { CompletionItem, Diagnostic } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "compiler/lsp/diagnosticSeverity";

const CompletionItemKind = {
  Method: 2,
  Function: 3,
} as const;

const CompletionItemInsertTextFormat = {
  Snippet: 2,
} as const;

export interface MonacoMarkerSeverityValues {
  Error: number;
  Warning: number;
  Info: number;
}

export interface MonacoLikeMarker {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  severity: number;
  message: string;
  code?: string | number | { value?: string | number };
  source?: string;
}

export interface MonacoLikeCompletionInsert {
  insertText: string;
  insertTextFormat?: number;
  command?: {
    title: string;
    command: string;
  };
}

function isCallableCompletionItem(item: Pick<CompletionItem, "kind" | "label">): boolean {
  if (item.kind !== CompletionItemKind.Method && item.kind !== CompletionItemKind.Function) {
    return false;
  }
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(item.label);
}

export function completionInsertText(item: Pick<CompletionItem, "kind" | "label" | "insertText" | "insertTextFormat">): MonacoLikeCompletionInsert {
  if (item.insertText) {
    return {
      insertText: item.insertText,
      ...(item.insertTextFormat !== undefined ? { insertTextFormat: item.insertTextFormat } : {}),
      ...(item.command ? { command: item.command } : {}),
    };
  }
  if (isCallableCompletionItem(item)) {
    return {
      insertText: `${item.label}($1)`,
      insertTextFormat: CompletionItemInsertTextFormat.Snippet,
      command: {
        title: "Trigger parameter hints",
        command: "editor.action.triggerParameterHints",
      },
    };
  }
  return { insertText: item.label };
}

export function markerToDiagnostic(
  marker: MonacoLikeMarker,
  markerSeverity: MonacoMarkerSeverityValues
): Diagnostic {
  const rawCode = marker.code;
  const code = typeof rawCode === "object" && rawCode !== null ? rawCode.value : rawCode;
  return {
    range: {
      start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
      end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
    },
    severity:
      marker.severity === markerSeverity.Error
        ? DiagnosticSeverity.Error
        : marker.severity === markerSeverity.Warning
          ? DiagnosticSeverity.Warning
          : marker.severity === markerSeverity.Info
            ? DiagnosticSeverity.Information
            : DiagnosticSeverity.Hint,
    message: marker.message,
    ...(code !== undefined ? { code } : {}),
    ...(marker.source !== undefined ? { source: marker.source } : {}),
  };
}
