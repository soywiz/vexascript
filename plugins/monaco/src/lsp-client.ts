/**
 * Minimal JSON-RPC 2.0 client over a plain WebSocket.
 *
 * The MyLang LSP server speaks standard JSON-RPC framed with Content-Length
 * headers over stdio.  server.mjs strips those headers so that each WebSocket
 * frame carries exactly one raw JSON object.
 */

type Handler<T = unknown> = (params: T) => void | Promise<void>;
type RequestHandler<T = unknown> = (params: unknown) => T | Promise<T>;

export class LspClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private readonly notifHandlers = new Map<string, Handler[]>();
  private readonly reqHandlers = new Map<string, RequestHandler>();

  readonly ready: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () =>
        reject(new Error("WebSocket connection failed"))
      );
    });
    this.ws.addEventListener("message", (ev) => {
      this.handleMessage(JSON.parse(ev.data as string) as Record<string, unknown>);
    });
    this.ws.addEventListener("close", () => {
      // Reject all pending requests so callers don't hang forever.
      for (const cb of this.pending.values()) {
        cb.reject(new Error("WebSocket closed"));
      }
      this.pending.clear();
    });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    if ("id" in msg && msg.id !== null) {
      if ("method" in msg) {
        // Server-to-client request — must send back a response.
        const handler = this.reqHandlers.get(msg.method as string);
        let result: unknown = null;
        let error: unknown = undefined;
        try {
          result = handler ? await handler(msg.params) : null;
        } catch (e) {
          error = { code: -32603, message: String(e) };
        }
        this.send(
          error !== undefined
            ? { jsonrpc: "2.0", id: msg.id, error }
            : { jsonrpc: "2.0", id: msg.id, result }
        );
      } else {
        // Response to a previous client request.
        const cb = this.pending.get(msg.id as number);
        if (cb) {
          this.pending.delete(msg.id as number);
          if (msg.error) cb.reject(msg.error);
          else cb.resolve(msg.result);
        }
      }
    } else if ("method" in msg) {
      // Notification from server.
      const handlers = this.notifHandlers.get(msg.method as string) ?? [];
      for (const h of handlers) {
        void h(msg.params);
      }
    }
  }

  private send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /** Send a request and await the response. */
  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.ready;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a one-way notification (no response expected). */
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Register a handler for server-sent notifications. */
  onNotification<T = unknown>(method: string, handler: Handler<T>): void {
    if (!this.notifHandlers.has(method)) this.notifHandlers.set(method, []);
    this.notifHandlers.get(method)!.push(handler as Handler);
  }

  /** Register a handler for server-to-client requests (must return a result). */
  onRequest<T = unknown>(method: string, handler: RequestHandler<T>): void {
    this.reqHandlers.set(method, handler as RequestHandler);
  }

  close(): void {
    this.ws.close();
  }
}
