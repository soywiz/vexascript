/**
 * LSP client backed by a Web Worker running the MyLang compiler directly.
 *
 * Replaces the WebSocket-based LspClient.  The interface is identical so
 * lsp-providers.ts and main.ts need only minimal changes (swap the import
 * and constructor call).
 *
 * The worker uses vscode-languageserver/browser which sends raw JSON-RPC
 * message objects via postMessage (not JSON strings).
 */

type Handler<T = unknown> = (params: T) => void | Promise<void>;
type RequestHandler<T = unknown> = (params: unknown) => T | Promise<T>;

export class CompilerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private readonly notifHandlers = new Map<string, Handler[]>();
  private readonly reqHandlers = new Map<string, RequestHandler>();

  /** Resolves immediately — the worker is ready as soon as it is created. */
  readonly ready: Promise<void> = Promise.resolve();

  constructor(workerUrl: URL) {
    this.worker = new Worker(workerUrl, { type: "module" });
    this.worker.addEventListener("message", (ev) => {
      this.handleMessage(ev.data as Record<string, unknown>);
    });
    this.worker.addEventListener("error", (ev) => {
      console.error("[compiler-worker] error:", ev.message);
      for (const cb of this.pending.values()) {
        cb.reject(new Error("Worker error: " + ev.message));
      }
      this.pending.clear();
    });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    if ("id" in msg && msg["id"] !== null && msg["id"] !== undefined) {
      if ("method" in msg) {
        // Server-to-client request — must send a response.
        const handler = this.reqHandlers.get(msg["method"] as string);
        let result: unknown = null;
        let error: unknown = undefined;
        try {
          result = handler ? await handler(msg["params"]) : null;
        } catch (e) {
          error = { code: -32603, message: String(e) };
        }
        this.send(
          error !== undefined
            ? { jsonrpc: "2.0", id: msg["id"], error }
            : { jsonrpc: "2.0", id: msg["id"], result }
        );
      } else {
        // Response to one of our requests.
        const cb = this.pending.get(msg["id"] as number);
        if (cb) {
          this.pending.delete(msg["id"] as number);
          if (msg["error"]) cb.reject(msg["error"]);
          else cb.resolve(msg["result"]);
        }
      }
    } else if ("method" in msg) {
      // Notification from the server.
      const handlers = this.notifHandlers.get(msg["method"] as string) ?? [];
      for (const h of handlers) {
        void h(msg["params"]);
      }
    }
  }

  private send(obj: unknown): void {
    this.worker.postMessage(obj);
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  onNotification<T = unknown>(method: string, handler: Handler<T>): void {
    if (!this.notifHandlers.has(method)) this.notifHandlers.set(method, []);
    this.notifHandlers.get(method)!.push(handler as Handler);
  }

  onRequest<T = unknown>(method: string, handler: RequestHandler<T>): void {
    this.reqHandlers.set(method, handler as RequestHandler);
  }

  close(): void {
    this.worker.terminate();
  }
}
