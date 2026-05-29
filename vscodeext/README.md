# MyLang VS Code Extension

This extension wires VS Code `.my` files to the MyLang language server.

## How it works

- Registers language id `mylang` for `*.my`.
- Starts the bundled server using:
  - `node ../dist/mylang.js --lsp`
- Uses stdio transport via `vscode-languageclient`.

## Local development

1. Build the compiler/LSP bundle from the repo root:

```bash
pnpm build
```

2. Install extension dependencies:

```bash
cd vscodeext
pnpm install
```

3. Open `vscodeext` in VS Code and launch the extension host (`F5`).
