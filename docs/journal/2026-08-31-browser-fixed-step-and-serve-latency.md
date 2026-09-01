# Browser fixed-step hang and `vexa serve` latency

## Symptom

A PixiJS platform game showed only its blue background under both Vite and
`vexa serve`. The renderer consumed a full CPU core and became so unresponsive
that browser pause, evaluation, and profiling could not attach reliably.
`vexa serve` also printed no progress while doing expensive initial semantic
work, which made the compiler look dead before the browser even loaded.

## Investigation

The useful isolation boundary was the application ticker. Asset loading and the
game constructor remained responsive, while calling `PlatformGame.start()`
immediately locked the renderer. The emitted fixed timestep exposed the bug:

```javascript
const FIXED_STEP = (1 / 60) | 0;
```

That value is zero. The game's normal accumulator loop therefore stayed true
and subtracted zero forever. This was not an import recursion: the module graph
already guards in-progress modules. Type-only imports did, however, make the
initial bundle much slower because serve repeatedly collected declarations and
walked package typings that runtime emission did not need.

OS-level sampling was useful to establish the 100% renderer loop, but minified
JIT stacks could not identify the source expression. Incrementally restoring
startup phases located the first synchronous call that stopped yielding and was
the decisive technique.

## Fix

- Unsuffixed numeric literals use TypeScript `number` semantics, so fixed
  timesteps such as `1 / 60` remain fractional. `/` preserves matching operand
  types: `number` division remains fractional, while `int`, `long`, and
  `bigint` division remains integral. Explicit integer values use the `i`
  suffix or `int(value)`, while the `\` operator forces integer division of
  `number` operands.
- Literal `\` divisions and `i`-suffixed `/` divisions that truncate to zero
  produce a source-located warning.
  Warnings flow through both the Vite plugin and CLI serve output.
- `vexa serve` uses transpile-only graph construction by default; `--type-check`
  opts back into whole-project semantic checking. Pure type-only local imports
  and package typing collection are skipped on this runtime-only path.
- Type-query dependency scans are cached per declaration node so repeated
  analysis does not rescan immutable AST subtrees.
- Serve reports initial bundling progress, rewrites a Vite-style `.vx` script
  entrypoint, exposes the conventional `public/` directory at the URL root, and
  injects side-effect CSS imports into the browser document.

## Regression coverage

Tests cover fractional `number` division, type-preserving integer `/`, explicit
`\` division and zero-truncation warnings, propagation of warnings through
Vite, transpile-only type-import
elision, Vite-style serve entrypoints, public assets, and browser CSS injection.
The platformer remains an end-to-end sample because its zero-step accumulator
turns this otherwise subtle numeric mismatch into an immediate failure.
