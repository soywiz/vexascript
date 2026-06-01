import {
  type Diagnostic,
  DiagnosticSeverity,
  type Position
} from "vscode-languageserver/node.js";
import type { AnalysisSession } from "./analysisSession";
import { createAnalysisSession } from "./analysisSession";
import {
  classifySemanticDiagnosticMessage,
  mapAnalysisIssueCodeToDiagnosticCode,
  MYLANG_DIAGNOSTIC_CODES
} from "./diagnosticCodes";

function fallbackRange() {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 }
  };
}

export function collectDiagnosticsFromSession(
  session: AnalysisSession,
  text: string,
  positionAt: (offset: number) => Position
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const issue of session.parserErrors) {
    const token = issue.token;
      diagnostics.push({
      code: MYLANG_DIAGNOSTIC_CODES.PARSER_ERROR,
      severity: DiagnosticSeverity.Error,
      range: token
        ? {
            start: {
              line: token.range.start.line,
              character: token.range.start.column
            },
            end: {
              line: token.range.end.line,
              character: token.range.end.column
            }
          }
        : fallbackRange(),
      message: issue.message,
      source: "mylang-ls"
    });
  }

  if (session.tokenizeError) {
    diagnostics.push({
      code: MYLANG_DIAGNOSTIC_CODES.TOKENIZE_ERROR,
      severity: DiagnosticSeverity.Error,
      range: {
        start: {
          line: session.tokenizeError.range.start.line,
          character: session.tokenizeError.range.start.column
        },
        end: {
          line: session.tokenizeError.range.end.line,
          character: session.tokenizeError.range.end.column
        }
      },
      message: session.tokenizeError.message,
      source: "mylang-ls"
    });
  }

  if (session.fatalError) {
    diagnostics.push({
      code: MYLANG_DIAGNOSTIC_CODES.FATAL_ERROR,
      severity: DiagnosticSeverity.Error,
      range: fallbackRange(),
      message: session.fatalError,
      source: "mylang-ls"
    });
  }

  if (session.analysis) {
    for (const issue of session.analysis.getIssues()) {
      const token = issue.node.firstToken;
      if (!token) {
        continue;
      }
      diagnostics.push({
        code:
          mapAnalysisIssueCodeToDiagnosticCode(issue.code) ??
          classifySemanticDiagnosticMessage(issue.message) ??
          MYLANG_DIAGNOSTIC_CODES.SEMANTIC_ERROR,
        severity: DiagnosticSeverity.Error,
        range: {
          start: {
            line: token.range.start.line,
            character: token.range.start.column
          },
          end: {
            line: token.range.end.line,
            character: token.range.end.column
          }
        },
        message: issue.message,
        source: "mylang-sema",
        ...(issue.data ? { data: issue.data } : {})
      });
    }
  }

  const anyIndex = text.indexOf("any");
  if (anyIndex >= 0) {
    diagnostics.push({
      code: MYLANG_DIAGNOSTIC_CODES.STYLE_AVOID_ANY,
      severity: DiagnosticSeverity.Warning,
      range: {
        start: positionAt(anyIndex),
        end: positionAt(anyIndex + 3)
      },
      message: "MyLang: avoid 'any' when possible.",
      source: "mylang-ls"
    });
  }

  return diagnostics;
}

export function collectDiagnostics(
  text: string,
  positionAt: (offset: number) => Position
): Diagnostic[] {
  const session = createAnalysisSession(text);
  return collectDiagnosticsFromSession(session, text, positionAt);
}
