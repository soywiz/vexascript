# VexaScript

VexaScript is a modern language derived from TypeScript. It keeps the TypeScript ecosystem while introducing deliberate `.vx` syntax differences and compiles to JavaScript. TypeScript inputs retain TypeScript semantics through the dedicated `.ts`/`.tsx` parser mode.

It is designed to be concise for humans and efficient for AI: less syntactic noise, fewer tokens, same expressive power.

## Features

- **Concise declarations** — canonical `func`/`const`, aliases such as `fn`/`fun`/`val`, primary-constructor classes, shorthand properties
- **Operator overloading** — define `operator+`, `operator-`, `operator*`, etc. on any class
- **Await-less async** — `sync func` automatically awaits produced promises; `go` opts out
- **Delegated variables** — Kotlin-style `by` delegates for computed properties and reactive state
- **New-less instantiation** — call `Point(1, 2)` instead of `new Point(1, 2)`
- **Optional `this`** — members can omit `this.` in most positions
- **`int` and `long` types** — integer semantics on top of JS numbers
- **Trailing lambdas** — pass a lambda after the closing paren of a call
- **Null-aware access** — `?.`, `??`, and non-null assertions
- **Full JS/TS interop** — consume any npm package or TypeScript declaration file
- **JavaScript output** — emit ESM with source maps for Node.js and browser projects

## Install

```bash
npm install -g vexascript
```

## Quick start

```bash
# Run a file directly
vexa run hello.vx

# Compile to JavaScript
vexa build hello.vx -o dist/hello.js

# Format in place
vexa format hello.vx --write

# Run tests
vexa test
```

## VS Code extension

Install the [VexaScript VS Code extension](https://marketplace.visualstudio.com/items?itemName=soywiz.vexascript-vscodeext) for diagnostics, quick fixes, go-to-definition, hover docs, and completions.

## Vite

The main `vexascript` package includes a dependency-free Vite plugin entrypoint. Vite remains a development dependency of the application, not a dependency of VexaScript:

```bash
npm install --save-dev vite vexascript
```

```javascript
// vite.config.mjs
import { defineConfig } from "vite";
import { vexascript } from "vexascript/vite";

export default defineConfig({
  plugins: [vexascript()]
});
```

Vite can then load `.vx` entrypoints and imports directly. The plugin emits ESM and source maps, respects the nearest `vexascript.json` or `tsconfig.json` JSX factory settings, and supports normal Vite development, production builds, and HMR.

Like Vite's TypeScript transform, this per-module transform does not perform whole-project type checking. Use the VexaScript language server for editor diagnostics and a CLI check in CI. See the runnable [`samples/vite`](samples/vite) project.

## CLI reference

| Command | Description |
|---|---|
| `vexa run <file>` | Execute a `.vx` file |
| `vexa build <file> -o <out>` | Compile to JavaScript |
| `vexa bundle <file> -o <out>` | Bundle local and package modules as JavaScript |
| `vexa format <file> [--write]` | Format source (print or overwrite) |
| `vexa tokens <file>` | Print the token stream |
| `vexa ast <file>` | Print the simplified AST |
| `vexa test [paths…]` | Run `.test.vx` files |
| `vexa --lsp` | Start the language server over stdio |

## Language tour

```vexascript
// Primary-constructor class with operator overloading
class Point(const x: number, const y: number) {
  operator-() => Point(-x, -y)
  operator+(other: Point) => Point(x + other.x, y + other.y)
  operator*(scale: number) => Point(x * scale, y * scale)
  length => Math.hypot(x, y)
}

const origin = Point(0, 0)
const p = -Point(1, 2) + Point(3, 4) * 2

// sync func — await-less async
sync func loadUser(id: string): User {
  const data = fetch(`/api/users/${id}`).json()
  return User(data.id, data.name)
}

// Delegated reactive variable
func useState(value: number) {
  return [() => value, (v: number) => { value = v }]
}

var count by useState(0)
count++
```

## Documentation

- [Syntax reference](https://vexascript.com/syntax)
- [CLI guide](https://vexascript.com/cli)
- [Quickstart](https://vexascript.com/quickstart)
- [Embedding guide](https://vexascript.com/embed)
- [Playground](https://vexascript.com/playground)

## Development

```bash
# Install dependencies
pnpm install

# Build the CLI and package integrations (dist/vexa.js and dist/vite.js)
pnpm build

# Run the full test suite
pnpm test

# Run with coverage
pnpm coverage

# Open VS Code with the extension in dev mode
pnpm code

# Run the CLI from source
pnpm run cli <args>
```

## License

See [LICENSE](LICENSE).
