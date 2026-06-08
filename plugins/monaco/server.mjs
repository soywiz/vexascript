/**
 * MyLang Monaco Editor — backend server
 *
 * Responsibilities:
 *   1. Serve the built frontend (production) or respond to API requests (dev).
 *   2. Expose /api/workspace so the browser can discover the file URI and
 *      initial content without a file system.
 *   3. Expose /api/save to persist editor changes back to disk.
 *
 * The LSP runs entirely inside a Web Worker in the browser — no WebSocket,
 * no child-process spawning, and no LSP traffic crosses the network.
 */

import { createServer } from "http";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFile, writeFile, access } from "fs/promises";
import express from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const IS_PROD = process.env.NODE_ENV === "production";

const WORKSPACE_DIR = resolve(__dirname, "sample");
const SAMPLE_FILE = resolve(WORKSPACE_DIR, "main.my");

try {
  await access(SAMPLE_FILE);
} catch {
  console.error(`[error] Sample file not found at ${SAMPLE_FILE}`);
  process.exit(1);
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

if (IS_PROD) {
  app.use(express.static(resolve(__dirname, "dist")));
}

/** Returns the workspace root URI and sample file info for the browser. */
app.get("/api/workspace", async (_req, res) => {
  try {
    const content = await readFile(SAMPLE_FILE, "utf-8");
    const toFileUri = (p) =>
      "file://" + (p.startsWith("/") ? p : "/" + p.replace(/\\/g, "/"));
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
app.post("/api/save", async (req, res) => {
  try {
    const { content } = req.body;
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }
    await writeFile(SAMPLE_FILE, content, "utf-8");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const httpServer = createServer(app);
httpServer.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  if (!IS_PROD) {
    console.log(
      "[server] Frontend dev server → http://localhost:5173  (run: vite)"
    );
  }
});
