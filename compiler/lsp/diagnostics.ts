import {
  type Diagnostic,
  type DocumentDiagnosticReport,
  type Position
} from "vscode-languageserver/node.js";
import type { AnalysisSession } from "./analysisSession";
import { createAnalysisSession } from "./analysisSession";
import {
  classifySemanticDiagnosticMessage,
  mapAnalysisIssueCodeToDiagnosticCode,
  VEXA_DIAGNOSTIC_CODES
} from "./diagnosticCodes";
import { DiagnosticSeverity } from "./diagnosticSeverity";

const DocumentDiagnosticReportKind = {
  Full: "full"
} as const;

const DiagnosticTag = {
  Unnecessary: 1
} as const;

function fallbackRange() {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 }
  };
}

function nodeDiagnosticRange(node: {
  firstToken?: { range: { start: { line: number; column: number } } };
  lastToken?: { range: { end: { line: number; column: number } } };
}) {
  if (!node.firstToken || !node.lastToken) {
    return null;
  }
  return {
    start: {
      line: node.firstToken.range.start.line,
      character: node.firstToken.range.start.column
    },
    end: {
      line: node.lastToken.range.end.line,
      character: node.lastToken.range.end.column
    }
  };
}

function diagnosticKey(diagnostic: Diagnostic): string {
  return [
    diagnostic.source ?? "",
    String(diagnostic.code ?? ""),
    diagnostic.message,
    diagnostic.range.start.line,
    diagnostic.range.start.character,
    diagnostic.range.end.line,
    diagnostic.range.end.character
  ].join("|");
}

export function collectDiagnosticsFromSession(
  session: AnalysisSession,
  text: string,
  positionAt: (offset: number) => Position
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();

  const pushDiagnostic = (diagnostic: Diagnostic): void => {
    const key = diagnosticKey(diagnostic);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  for (const issue of session.parserErrors) {
    const token = issue.token;
    pushDiagnostic({
      code: VEXA_DIAGNOSTIC_CODES.PARSER_ERROR,
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
      source: "vexa-ls"
    });
  }

  if (session.tokenizeError) {
    pushDiagnostic({
      code: VEXA_DIAGNOSTIC_CODES.TOKENIZE_ERROR,
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
      source: "vexa-ls"
    });
  }

  if (session.fatalError) {
    pushDiagnostic({
      code: VEXA_DIAGNOSTIC_CODES.FATAL_ERROR,
      severity: DiagnosticSeverity.Error,
      range: fallbackRange(),
      message: session.fatalError,
      source: "vexa-ls"
    });
  }

  if (session.semanticIssues.length > 0) {
    for (const issue of session.semanticIssues) {
      const range = issue.range ?? nodeDiagnosticRange(issue.node);
      if (!range) {
        continue;
      }
      pushDiagnostic({
        code:
          mapAnalysisIssueCodeToDiagnosticCode(issue.code) ??
          classifySemanticDiagnosticMessage(issue.message) ??
          VEXA_DIAGNOSTIC_CODES.SEMANTIC_ERROR,
        severity: DiagnosticSeverity.Error,
        range,
        message: issue.message,
        source: "vexa-sema",
        ...(issue.data ? { data: issue.data } : {})
      });
    }
  }

  for (const identifier of session.analysis?.getUnusedImportIdentifiers() ?? []) {
    const token = identifier.firstToken;
    if (!token) {
      continue;
    }
    pushDiagnostic({
      code: VEXA_DIAGNOSTIC_CODES.STYLE_UNUSED_IMPORT,
      severity: DiagnosticSeverity.Hint,
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
      message: `Imported symbol '${identifier.name}' is never used.`,
      source: "vexa-ls",
      tags: [DiagnosticTag.Unnecessary]
    });
  }

  const anyIndex = text.indexOf("any");
  if (anyIndex >= 0) {
    pushDiagnostic({
      code: VEXA_DIAGNOSTIC_CODES.STYLE_AVOID_ANY,
      severity: DiagnosticSeverity.Warning,
      range: {
        start: positionAt(anyIndex),
        end: positionAt(anyIndex + 3)
      },
      message: "VexaScript: avoid 'any' when possible.",
      source: "vexa-ls"
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

export function createDocumentDiagnosticReport(
  session: AnalysisSession,
  text: string,
  positionAt: (offset: number) => Position,
  resultId?: string
): DocumentDiagnosticReport {
  return {
    kind: DocumentDiagnosticReportKind.Full,
    items: collectDiagnosticsFromSession(session, text, positionAt),
    ...(resultId ? { resultId } : {})
  };
}
