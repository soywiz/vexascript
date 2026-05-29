const app = document.querySelector<HTMLDivElement>("#app");

if (app) {
  app.innerHTML = `
    <main style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; padding: 2rem;">
      <h1>MyLang Playground</h1>
      <p>Base project ready. Use the CLI: <code>mylang</code>.</p>
      <p>Language server mode: <code>mylang --language-server</code>.</p>
    </main>
  `;
}
