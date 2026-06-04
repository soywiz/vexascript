# MyLang

MyLang is a language derived from TypeScript.

Node.js CLI project with:

- Compiler CLI in a single bundle (`dist/mylang.js`).
- Language Server embedded in the same CLI with `--language-server` or `--lsp`.

## Install

```bash
pnpm install
```

## Build

```bash
pnpm build
```

This generates:

- `dist/mylang.js` (single bundle for compiler + tooling + LSP)

## Build and run CLI in one command

```bash
pnpm run cli <args>
```

Example:

```bash
pnpm run cli tokens example.my
```

## Tests (TDD)

```bash
pnpm test
```

```bash
pnpm test:watch
```

MyLang test files use the `.test.my` suffix and have inline `test` and `assert` helpers available without imports:

```my
test(() => {
  assert(1 + 1 == 2)
})
```

Run every `.test.my` file below the current directory, or pass one or more files/directories to limit discovery:

```bash
pnpm run cli test
pnpm run cli test compiler-tests math.test.my
```

## CLI usage

### Compile a file

```bash
pnpm node dist/mylang.js build example.my -o example.js
```

### View tokens

```bash
pnpm node dist/mylang.js tokens example.my
```

### View simplified AST

```bash
pnpm node dist/mylang.js ast example.my
```

### Format a file

```bash
pnpm node dist/mylang.js format example.my
```

Overwrite the input file in place:

```bash
pnpm node dist/mylang.js format example.my --write
```

### Start language server

```bash
pnpm node dist/mylang.js --language-server
```

```bash
pnpm node dist/mylang.js --lsp
```

The LSP server communicates via `stdio` for editor integration.

You can also see this documented in CLI help:

```bash
pnpm node dist/mylang.js --help
```

## VS Code extension (local dev)

```bash
pnpm run vscodeext:launch
```

This command installs extension dependencies, builds the compiler/LSP, and opens VS Code with `plugins/vscode` as the extension development path.
