const app = document.querySelector<HTMLDivElement>("#app");

if (app) {
  app.innerHTML = `
    <main style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; padding: 2rem;">
      <h1>MyLang Playground</h1>
      <p>Proyecto base listo. Usa la CLI: <code>mylang</code>.</p>
      <p>Modo language server: <code>mylang --language-server</code>.</p>
    </main>
  `;
}
