function registerDependencyRefreshOnFocus(windowApi, client, ready, command) {
  return windowApi.onDidChangeWindowState((state) => {
    if (!state.focused) {
      return;
    }
    void Promise.resolve(ready)
      .then(() => client.sendRequest("workspace/executeCommand", { command }))
      .catch(() => {
        // The next focus or filesystem event retries after server startup/restart.
      });
  });
}

module.exports = { registerDependencyRefreshOnFocus };
