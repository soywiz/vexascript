/**
 * Web Worker entry point for the VexaScript LSP.
 *
 * This worker runs the full LSP server in-browser using the
 * vscode-languageserver/browser MessagePort transport.  The main thread
 * creates this worker and communicates over postMessage / onmessage —
 * no WebSocket or child process is involved.
 */

import { startLspInWorker } from "../../../compiler/lsp/server-browser";

startLspInWorker();
