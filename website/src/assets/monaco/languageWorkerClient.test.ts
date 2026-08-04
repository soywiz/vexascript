import { describe, expect, it } from "compiler/test/expect";
import { LanguageWorkerClient, type LanguageWorkerTransport } from "./languageWorkerClient";

class FakeWorker implements LanguageWorkerTransport {
  readonly requests: unknown[] = [];
  private messageListener?: (event: { data: unknown }) => void;
  private errorListener?: () => void;

  addEventListener(type: "message" | "error", listener: ((event: { data: unknown }) => void) | (() => void)): void {
    if (type === "message") {
      this.messageListener = listener as (event: { data: unknown }) => void;
      return;
    }
    this.errorListener = listener as () => void;
  }

  postMessage(message: unknown): void {
    this.requests.push(message);
  }

  terminate(): void {}

  respond(data: unknown): void {
    this.messageListener?.({ data });
  }

  fail(): void {
    this.errorListener?.();
  }
}

describe("LanguageWorkerClient", () => {
  it("preserves null as a successful worker result", async () => {
    const worker = new FakeWorker();
    const client = new LanguageWorkerClient(() => worker);

    const resultPromise = client.request("hover", { uri: "file:///main.vx" });
    worker.respond({ id: 1, result: null });

    expect(await resultPromise).toEqual({ ok: true, value: null });
  });

  it("fails pending and future requests without invoking main-thread work when the worker stops", async () => {
    const worker = new FakeWorker();
    let creations = 0;
    const client = new LanguageWorkerClient(() => {
      creations += 1;
      return worker;
    });

    const pending = client.request("diagnostics", { uri: "file:///main.vx" });
    worker.fail();

    expect(await pending).toEqual({ ok: false });
    expect(await client.request("diagnostics", { uri: "file:///main.vx" })).toEqual({ ok: false });
    expect(creations).toBe(1);
  });
});
