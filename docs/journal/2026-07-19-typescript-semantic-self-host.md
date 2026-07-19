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

The native CLI now exposes asynchronous captured child-process execution. The
blocking process wait runs on a background future while the native event loop
polls completion, so compiler code does not introduce synchronous I/O. The
native `cliShared` adapter uses this primitive to run the same `tsc --noEmit`
validation as the Node adapter before emitting JavaScript or C++.

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

The child-process bridge was first attempted with a class-typed options object.
That made ordinary object-literal call sites fail in generated C++ because the
record was not adapted to the generated class pointer. Keeping adapter options
dynamic matches the Node boundary and confines the dynamic access to the
platform shim. The runtime also copies command arguments before starting the
background operation; retaining an Oilpan array pointer in the worker would
cross the collector boundary and be unsafe.

The native smoke covers successful command capture in the existing complete
behavioral program. A manually compiled native CLI also rejects an invalid
TypeScript assignment through `tsc` and completes its first checked C++
self-host generation without `--transpile-only`.
