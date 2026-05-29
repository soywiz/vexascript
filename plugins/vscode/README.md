# MyLang VS Code Extension

This extension wires VS Code `.my` files to the MyLang language server.

## How it works

- Registers language id `mylang` for `*.my`.
- Starts the bundled server using:
  - `node ../../dist/mylang.js --lsp`
- Uses stdio transport via `vscode-languageclient`.

## Local development

1. From the repo root, install extension dependencies:

```bash
pnpm run vscodeext:install
```

2. Build the compiler/LSP bundle:

```bash
pnpm build
```

3. Launch VS Code with the extension in development mode:

```bash
pnpm run vscodeext:launch
```

4. Open any `.my` file. It should be recognized as `mylang` and show parse/tokenizer diagnostics while editing.

Alternative debug flow:

- Open `plugins/vscode` in VS Code.
- Run `F5` with the `Run MyLang Extension` launch config (`plugins/vscode/.vscode/launch.json`).
