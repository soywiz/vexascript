export interface LanguageWorkerTransport {
  addEventListener(
    type: "message" | "error",
    listener: ((event: { data: unknown }) => void) | (() => void)
  ): void;
  postMessage(message: unknown): void;
  terminate(): void;
}

export type LanguageWorkerResult<T> =
  | { ok: true; value: T }
  | { ok: false };

interface LanguageWorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve(result: LanguageWorkerResult<unknown>): void;
}

function isLanguageWorkerResponse(value: unknown): value is LanguageWorkerResponse {
  return typeof value === "object"
    && value !== null
    && "id" in value
    && typeof value.id === "number";
}

export class LanguageWorkerClient {
  private worker: LanguageWorkerTransport | null = null;
  private nextRequestId = 0;
  private disabled = false;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly createWorker: () => LanguageWorkerTransport,
    private readonly onUnavailable: () => void = () => {}
  ) {}

  request<T>(
    feature: string,
    snapshot: unknown,
    params: Record<string, unknown> = {}
  ): Promise<LanguageWorkerResult<T>> {
    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve({ ok: false });
    }

    const id = ++this.nextRequestId;
    return new Promise<LanguageWorkerResult<T>>((resolve) => {
      this.pending.set(id, {
        resolve: (result) => resolve(result as LanguageWorkerResult<T>),
      });
      worker.postMessage({ id, feature, snapshot, params });
    });
  }

  private ensureWorker(): LanguageWorkerTransport | null {
    if (this.disabled) {
      return null;
    }
    if (this.worker) {
      return this.worker;
    }

    try {
      const worker = this.createWorker();
      worker.addEventListener("message", (event) => {
        this.handleMessage(event.data);
      });
      worker.addEventListener("error", () => {
        this.disable();
      });
      this.worker = worker;
      return worker;
    } catch {
      this.disable();
      return null;
    }
  }

  private handleMessage(data: unknown): void {
    if (!isLanguageWorkerResponse(data)) {
      return;
    }
    const pending = this.pending.get(data.id);
    if (!pending) {
      return;
    }
    this.pending.delete(data.id);
    pending.resolve(data.error ? { ok: false } : { ok: true, value: data.result });
  }

  private disable(): void {
    if (this.disabled) {
      return;
    }
    this.disabled = true;
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) {
      pending.resolve({ ok: false });
    }
    this.pending.clear();
    this.onUnavailable();
  }
}
