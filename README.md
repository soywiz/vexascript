# VexaScript

VexaScript is a modern language derived from TypeScript. It is a non-strict TypeScript superset that compiles to JavaScript and, for a growing native subset, C++ backed by Oilpan GC.

It is designed to be concise for humans and efficient for AI: less syntactic noise, fewer tokens, same expressive power.

## Features

- **Concise declarations** — `fun`, `val`, primary-constructor classes, shorthand properties
- **Operator overloading** — define `operator+`, `operator-`, `operator*`, etc. on any class
- **Await-less async** — `sync fun` automatically awaits produced promises; `go` opts out
- **Delegated variables** — Kotlin-style `by` delegates for computed properties and reactive state
- **New-less instantiation** — call `Point(1, 2)` instead of `new Point(1, 2)`
- **Optional `this`** — members can omit `this.` in most positions
- **`int` and `long` types** — integer semantics on top of JS numbers
- **Trailing lambdas** — pass a lambda after the closing paren of a call
- **Null-aware access** — `?.`, `??`, and non-null assertions
- **Full JS/TS interop** — consume any npm package or TypeScript declaration file
- **Native C++ output** — emit C++ or link a native Oilpan executable with `g++`

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

# Emit C++ without compiling it
vexa cpp hello.vx

# Emit C++, then build and link an Oilpan executable
vexa executable hello.vx

# Format in place
vexa format hello.vx --write

# Run tests
vexa test
```

## VS Code extension

Install the [VexaScript VS Code extension](https://marketplace.visualstudio.com/items?itemName=soywiz.vexascript-vscodeext) for diagnostics, quick fixes, go-to-definition, hover docs, and completions.

## CLI reference

| Command | Description |
|---|---|
| `vexa run <file>` | Execute a `.vx` file |
| `vexa build <file> -o <out>` | Compile to JavaScript |
| `vexa cpp <file> [-o output.cpp]` | Emit a C++ translation unit without compiling it |
| `vexa executable <file> [-o executable]` | Emit C++ in `<file>.build/`, build Oilpan with `g++`, and link an executable |
| `vexa native <file>` | Compatibility alias for `executable` |
| `vexa build <file> --emit cpp` | Compatibility form of the `cpp` workflow |
| `vexa build <file> --native` | Compatibility form of the `executable` workflow |
| `vexa format <file> [--write]` | Format source (print or overwrite) |
| `vexa tokens <file>` | Print the token stream |
| `vexa ast <file>` | Print the simplified AST |
| `vexa test [paths…]` | Run `.test.vx` files |
| `vexa --lsp` | Start the language server over stdio |

## Language tour

```vexascript
// Primary-constructor class with operator overloading
class Point(val x: number, val y: number) {
  operator-() => Point(-x, -y)
  operator+(other: Point) => Point(x + other.x, y + other.y)
  operator*(scale: number) => Point(x * scale, y * scale)
  length => Math.hypot(x, y)
}

val origin = Point(0, 0)
val p = -Point(1, 2) + Point(3, 4) * 2

// sync fun — await-less async
sync fun loadUser(id: string): User {
  val data = fetch(`/api/users/${id}`).json()
  return User(data.id, data.name)
}

// Delegated reactive variable
fun useState(value: number) {
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
- [Native C++ backend](docs/native.md)
- [Playground](https://vexascript.com/playground)

## Development

```bash
# Install dependencies
pnpm install

# Build the compiler bundle (dist/vexa.js)
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
