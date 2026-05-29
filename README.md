# MyLang

Base project with:

- Vite + TypeScript for the web playground.
- Compiler CLI in a single bundle (`dist/mylang.js`).
- Language Server embedded in the same CLI with `--language-server`.

## Install

```bash
pnpm install
```

## Web development

```bash
pnpm dev
```

## Build

```bash
pnpm build
```

This generates:

- `dist/` for the frontend (Vite)
- `dist/mylang.js` (single bundle for compiler + tooling + LSP)

## Tests (TDD)

```bash
pnpm test
```

```bash
pnpm test:watch
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

### Start language server

```bash
pnpm node dist/mylang.js --language-server
```

The LSP server communicates via `stdio` for editor integration.
