/**
 * MyLang Monaco Editor — backend server
 *
 * Responsibilities:
 *   1. Serve the built frontend (production) or proxy to Vite dev server.
 *   2. Accept WebSocket connections at /lsp, spawn a mylang LSP process per
 *      connection, and bridge WebSocket frames ↔ LSP stdio (Content-Length framing).
 *   3. Expose /api/workspace so the browser can discover the file URI and
 *      initial content without a file system.
 */

import { createServer } from "http";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync } from "fs";
import express from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const IS_PROD = process.env.NODE_ENV === "production";

const WORKSPACE_DIR = resolve(__dirname, "sample");
const SAMPLE_FILE = resolve(WORKSPACE_DIR, "main.my");
const LSP_BIN = resolve(__dirname, "../../dist/mylang.js");

// ── Validate prerequisites ────────────────────────────────────────────────────

if (!existsSync(LSP_BIN)) {
  console.error(
    `[error] LSP binary not found at ${LSP_BIN}\n` +
      `        Run "pnpm build" from the repository root first.`
  );
  process.exit(1);
}

if (!existsSync(SAMPLE_FILE)) {
  console.error(`[error] Sample file not found at ${SAMPLE_FILE}`);
  process.exit(1);
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

if (IS_PROD) {
  app.use(express.static(resolve(__dirname, "dist")));
} else {
  // In dev mode, Vite runs at port 5173 and proxies /api and /lsp here.
  // We don't need to serve static files — just respond to API routes.
}

/** Returns the workspace root URI and sample file info for the browser. */
app.get("/api/workspace", (_req, res) => {
  try {
    const content = readFileSync(SAMPLE_FILE, "utf-8");
    // On Windows the path already starts with a drive letter; prepend exactly one slash.
    const toFileUri = (p) => "file://" + (p.startsWith("/") ? p : "/" + p.replace(/\\/g, "/"));
    res.json({
      rootUri: toFileUri(WORKSPACE_DIR),
      fileUri: toFileUri(SAMPLE_FILE),
      content,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Persists editor content back to disk. */
app.post("/api/save", (req, res) => {
  try {
    const { content } = req.body;
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }
    writeFileSync(SAMPLE_FILE, content, "utf-8");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── HTTP server + WebSocket server ────────────────────────────────────────────

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/lsp" });

// ── LSP message parser (Content-Length framing → raw JSON strings) ─────────

class LspParser {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.flush();
  }

  flush() {
    while (this.buf.length > 0) {
      // Locate the \r\n\r\n separator between headers and body.
      let sep = -1;
      for (let i = 0; i < this.buf.length - 3; i++) {
        if (
          this.buf[i] === 0x0d &&
          this.buf[i + 1] === 0x0a &&
          this.buf[i + 2] === 0x0d &&
          this.buf[i + 3] === 0x0a
        ) {
          sep = i;
          break;
        }
      }
      if (sep === -1) return; // incomplete header

      const header = this.buf.slice(0, sep).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed: skip to after separator and retry.
        this.buf = this.buf.slice(sep + 4);
        continue;
      }

      const len = parseInt(match[1], 10);
      const start = sep + 4;
      if (this.buf.length < start + len) return; // incomplete body

      const json = this.buf.slice(start, start + len).toString("utf-8");
      this.buf = this.buf.slice(start + len);
      this.onMessage(json);
    }
  }
}

// ── WebSocket → LSP bridge ────────────────────────────────────────────────────

wss.on("connection", (ws) => {
  console.log("[lsp] client connected");

  const lsp = spawn("node", [LSP_BIN, "--lsp", "--stdio"], {
    cwd: WORKSPACE_DIR,
    stdio: ["pipe", "pipe", "pipe"],
  });

  lsp.on("error", (err) => {
    console.error("[lsp] spawn error:", err.message);
    if (ws.readyState === ws.OPEN) ws.close(1011, "LSP spawn error");
  });

  lsp.stderr.on("data", (d) => process.stderr.write("[lsp] " + d));

  // LSP stdout → WebSocket: strip Content-Length framing, send raw JSON.
  const parser = new LspParser((json) => {
    if (ws.readyState === ws.OPEN) ws.send(json);
  });
  lsp.stdout.on("data", (chunk) => parser.push(chunk));

  // WebSocket → LSP stdin: add Content-Length framing.
  ws.on("message", (data) => {
    const body = data.toString("utf-8");
    const byteLen = Buffer.byteLength(body, "utf-8");
    lsp.stdin.write(`Content-Length: ${byteLen}\r\n\r\n${body}`);
  });

  ws.on("close", () => {
    console.log("[lsp] client disconnected");
    lsp.kill();
  });

  ws.on("error", (err) => {
    console.error("[lsp] ws error:", err.message);
    lsp.kill();
  });

  lsp.on("exit", (code, signal) => {
    console.log(`[lsp] process exited (code=${code} signal=${signal})`);
    if (ws.readyState === ws.OPEN) ws.close();
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  console.log(`[server] LSP WebSocket → ws://localhost:${PORT}/lsp`);
  if (!IS_PROD) {
    console.log("[server] Frontend dev server → http://localhost:5173  (run: vite)");
  }
});
