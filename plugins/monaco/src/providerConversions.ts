import type { Diagnostic } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "compiler/lsp/diagnosticSeverity";

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
