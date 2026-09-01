# Vite project-aware constructor lowering

## Problem

The Vite plugin transpiled each `.vx` module without imported or configured
declarations. Calls using VexaScript's omitted-`new` syntax therefore emitted
as ordinary JavaScript calls when the constructor came from a package, a local
module, or a DOM global. `vexa serve` did not exhibit the package/local issue
because its module graph already carried project semantic context.

## Change

Vite transforms now collect and cache imported, ambient, and configured global
declarations before emission. The collection phase is serialized because Vite
may request cyclic modules concurrently; cached dependency results keep the
project graph bounded, and a changed source invalidates the shared import
cache. The emitter also recognizes constructor-only object type declarations
such as `declare var Audio: { new(...): HTMLAudioElement }`, while preserving
hybrid values that expose both call and construct signatures.

## Verification

- Plugin regressions cover package, local-module, concurrent cyclic, and DOM
  constructor calls without explicit `new`.
- A runtime regression covers constructor-only DOM globals.
- The complete 2,942-test suite passes.
- `pnpm build` succeeds for Question Kingdom, and a Playwright browser run of
  the Vite dev server loads the game with no console errors or warnings.

## Execution metadata

- Date: 2026-09-01
- Provider: OpenAI
- Model: Codex
