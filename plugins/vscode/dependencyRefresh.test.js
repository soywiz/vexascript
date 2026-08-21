const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { registerDependencyRefreshOnFocus } = require("./dependencyRefresh.js");

describe("dependency refresh on focus", () => {
  it("asks the language server to invalidate dependency caches when VS Code regains focus", async () => {
    let onWindowStateChanged;
    const requests = [];
    const subscription = { dispose() {} };
    const windowApi = {
      onDidChangeWindowState(listener) {
        onWindowStateChanged = listener;
        return subscription;
      }
    };
    const client = {
      sendRequest(method, params) {
        requests.push({ method, params });
        return Promise.resolve();
      }
    };

    const registered = registerDependencyRefreshOnFocus(
      windowApi,
      client,
      Promise.resolve(),
      "vexa.refreshDiagnostics"
    );
    assert.equal(registered, subscription);

    onWindowStateChanged({ focused: false });
    await Promise.resolve();
    assert.deepEqual(requests, []);

    onWindowStateChanged({ focused: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(requests, [{
      method: "workspace/executeCommand",
      params: { command: "vexa.refreshDiagnostics" }
    }]);
  });
});
