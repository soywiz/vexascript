# MyLang

Proyecto base con:

- Vite + TypeScript para playground web.
- Compilador CLI en un único bundle (`dist/mylang.js`).
- Language Server embebido en la misma CLI con `--language-server`.

## Instalar

```bash
pnpm install
```

## Desarrollo web

```bash
pnpm dev
```

## Build

```bash
pnpm build
```

Esto genera:

- `dist/` del frontend (Vite)
- `dist/mylang.js` (bundle único del compilador + herramientas + LSP)

## Tests (TDD)

```bash
pnpm test
```

```bash
pnpm test:watch
```

## Uso de la CLI

### Compilar archivo

```bash
pnpm node dist/mylang.js build ejemplo.my -o ejemplo.js
```

### Ver tokens

```bash
pnpm node dist/mylang.js tokens ejemplo.my
```

### Ver AST simplificado

```bash
pnpm node dist/mylang.js ast ejemplo.my
```

### Levantar language server

```bash
pnpm node dist/mylang.js --language-server
```

El servidor LSP se comunica por `stdio`, para integrarlo con editores.
