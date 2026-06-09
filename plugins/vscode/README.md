# MyLang VS Code Extension

This extension wires VS Code `.my` files to the MyLang language server.

## How it works

- Registers language id `mylang` for `*.my`.
- Adds syntax highlighting for `.my` via TextMate grammar (`source.mylang`).
- Adds a custom language icon for `.my` without replacing the active file icon theme.
- Starts the bundled server using:
  - `node ./dist/mylang.js --lsp`
- Uses stdio transport via `vscode-languageclient`.
- Exposes LSP editor features including:
  - diagnostics
  - completion
  - hover
  - go-to-definition
  - rename symbol
  - formatting, including selected ranges

## Local development

1. From `plugins/vscode`, install extension dependencies:

```bash
pnpm run setup
```

2. Build the compiler/LSP bundle:

```bash
pnpm run bundle-server
```

3. Launch VS Code with the extension in development mode:

```bash
pnpm run launch
```

To create a `.vsix` package you can send/install:

```bash
pnpm run package
```

This writes `mylang-vscodeext.vsix` in `plugins/vscode`.
The packaging command uses `vsce --no-dependencies` because the extension dependencies are installed with PNPM and `vsce`'s default npm dependency scan can fail on PNPM's layout.
The extension manifest now declares the repository and uses an explicit `files` allowlist, so `vsce` packages only the runtime assets we ship.
`setup` is intentionally separate from `launch` and `package`, so packaging does not force a reinstall every time.

From the repo root, the wrapper commands still work:

```bash
pnpm run vscodeext:install
pnpm run vscodeext:bundle
pnpm run vscodeext:launch
pnpm run vscodeext:package
```

4. Open any `.my` file. It should be recognized as `mylang` and show parse/tokenizer diagnostics while editing.

The `.my` icon is contributed by the language itself and does not require selecting a separate icon theme.

Alternative debug flow:

- Open `plugins/vscode` in VS Code.
- Run `F5` with the `Run MyLang Extension` launch config (`plugins/vscode/.vscode/launch.json`).
