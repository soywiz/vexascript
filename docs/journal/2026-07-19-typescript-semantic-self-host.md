# TypeScript semantic validation during self-hosting

## Problem

The JavaScript and C++ compiler bootstrap commands only succeeded with
`--transpile-only`. Enabling VexaScript type diagnostics for the TypeScript
compiler source produced thousands of false positives, mostly around advanced
TypeScript generics, control-flow narrowing, ambient Node.js declarations, and
the large emitter implementations.

The native module graph and the JavaScript module graph also lost the parser's
source-language mode when reusing parsed artifacts. That caused `.ts` files to
be analyzed with VexaScript-only rules such as mandatory `override`.

## Resolution

Parsed artifacts now retain their source language, and `compileParsedSource`
forwards it automatically. This removes a duplicated, easy-to-forget language
decision from every graph consumer.

CLI compilation uses the TypeScript compiler as the semantic authority for
`.ts` and `.tsx` projects. Once `tsc --noEmit` succeeds, VexaScript still runs
binding, inference, lowering, and emission, but does not report its incomplete
TypeScript compatibility diagnostics. `.vx` sources continue to use the full
VexaScript semantic checker. `--transpile-only` remains the explicit way to
skip semantic validation.

The JavaScript self-host test no longer passes `--transpile-only` at any
roundtrip and remains byte-stable after three generations.

## Investigation notes

An initial diagnostic count appeared to implicate `cppEmitter.ts` almost
exclusively, but that measurement omitted the project's `baseUrl` and therefore
misclassified internal `compiler/...` imports as unresolved packages. Repeating
the measurement with the real project configuration exposed the broader
TypeScript-compatibility gap. Attempting to silence or individually patch those
diagnostics would have weakened semantic correctness and created a long series
of source-level workarounds.

The full native smoke also caught an independent regression: optional native
collection calls were emitted as boxed `Value`s, but their emitted type was
incorrectly recorded as `bool`. As a result, `optionalCall(...) ?? false`
dropped the coalescing fallback. Optional member calls now consistently report
their boxed emitted type.

## Follow-up

The native CLI replacement currently cannot launch child processes, so its
TypeScript-source adapter cannot yet run the TypeScript checker itself. Before
claiming semantically checked native self-hosting, either the native CLI must
provide asynchronous child-process execution for `tsc`, or the compiler source
must become accepted by a sufficiently complete strict VexaScript checker.
