import type { AnalysisSession } from "compiler/lsp/analysisSession";
import { collectDiagnosticsFromSession } from "compiler/lsp/diagnostics";
import { collectCrossFileMemberDiagnostics } from "compiler/lsp/memberDiagnostics";
import { collectCrossFileTypeDiagnostics } from "compiler/lsp/crossFileTypeDiagnostics";
import type { Diagnostic } from "vscode-languageserver/node.js";

interface PositionLike {
  lineNumber: number;
  column: number;
}

export interface WorkspaceDiagnosticsModelLike {
  uri: { toString(): string };
  getValue(): string;
  getPositionAt(offset: number): PositionLike;
}

export interface WorkspaceDiagnosticsContext {
  getSessionForFilePath?: (filePath: string) => AnalysisSession | null | Promise<AnalysisSession | null>;
}

function diagnosticKey(diagnostic: Diagnostic): string {
  return [
    diagnostic.source ?? "",
    String(diagnostic.code ?? ""),
    diagnostic.message,
    diagnostic.range.start.line,
    diagnostic.range.start.character,
    diagnostic.range.end.line,
    diagnostic.range.end.character,
  ].join("|");
}

export async function collectWorkspaceDiagnostics(
  model: WorkspaceDiagnosticsModelLike,
  session: AnalysisSession,
  workspaceContext?: WorkspaceDiagnosticsContext
): Promise<Diagnostic[]> {
  const diagnostics = collectDiagnosticsFromSession(
    session,
    model.getValue(),
    (offset) => {
      const position = model.getPositionAt(offset);
      return { line: position.lineNumber - 1, character: position.column - 1 };
    }
  );

  if (!session.ast || !session.analysis) {
    return diagnostics;
  }

  const crossFileDiagnostics = await Promise.all([
    collectCrossFileMemberDiagnostics({
      uri: model.uri.toString(),
      session,
      sourceRoots: [],
      ...(workspaceContext?.getSessionForFilePath
        ? { getSessionForFilePath: workspaceContext.getSessionForFilePath }
        : {}),
    }),
    collectCrossFileTypeDiagnostics({
      uri: model.uri.toString(),
      session,
      sourceRoots: [],
      ...(workspaceContext?.getSessionForFilePath
        ? { getSessionForFilePath: workspaceContext.getSessionForFilePath }
        : {}),
    }),
  ]);

  const merged = [...diagnostics];
  const seen = new Set(merged.map((diagnostic) => diagnosticKey(diagnostic)));
  for (const diagnostic of crossFileDiagnostics.flat()) {
    const key = diagnosticKey(diagnostic);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(diagnostic);
  }
  return merged;
}
