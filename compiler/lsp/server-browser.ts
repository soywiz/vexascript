/**
 * Browser-compatible LSP server entry point.
 *
 * Differences from server.ts (the Node.js/stdio version):
 *   - Uses vscode-languageserver/browser transport (BrowserMessageReader/Writer)
 *     so the entire server runs inside a Web Worker.
 *   - No workspace environment is provided: the worker has no file-system
 *     source roots or project index resolver, so workspace-wide diagnostics,
 *     workspace symbols, and watched-file invalidation are not advertised.
 *     The shared handlers in serverCore.ts run with empty source roots, which
 *     keeps single-file features and ambient runtime navigation in parity
 *     with the Node server.
 */
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  BrowserMessageReader,
  BrowserMessageWriter
} from "vscode-languageserver/browser";
import { TextDocument as LspTextDocument } from "vscode-languageserver-textdocument";
import { AnalysisSessionCache } from "./analysisSession";
import { startLspServer } from "./serverCore";

export function startLspInWorker(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workerScope = self as any;
  const reader = new BrowserMessageReader(workerScope);
  const writer = new BrowserMessageWriter(workerScope);
  const connection = createConnection(ProposedFeatures.all, reader, writer);
  const documents = new TextDocuments(LspTextDocument);

  startLspServer({
    connection,
    documents,
    analysisSessions: new AnalysisSessionCache(),
    environment: {
      getSourceRoots: () => [],
      getSessionForFilePath: () => null
    }
  });
}
