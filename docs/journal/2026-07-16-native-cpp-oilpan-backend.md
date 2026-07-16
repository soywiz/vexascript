# Native C++ and Oilpan backend

## Context

The compiler previously treated JavaScript emission as the only terminal step.
Adding native output exposed an important phase-boundary requirement: a second
backend should reuse parsing, semantic analysis, diagnostics, and lowering,
without importing Node-only build concerns into browser-compatible compiler
modules.

## What worked

The C++ emitter is a browser-compatible compiler module selected only after the
normal compilation artifacts have passed diagnostics. Range loops reuse the
existing lowering pass, so `for (n of 0 ..< 10)` has one lowering rule shared
with optimized JavaScript output rather than a second interpretation in the C++
backend.

Oilpan extraction, CMake invocation, `g++` selection, and native linking live in
a CLI-only adapter. This preserves the compiler's browser compatibility and
keeps all process and filesystem work asynchronous. A dedicated `build-vexa`
CMake directory prevents collision with an Oilpan checkout's ordinary build
cache.

The direct `native` command keeps its generated translation unit under
`<source>.build/main.cpp` and accepts a separate executable output path. Oilpan
sources and its CMake build live in a versioned OS temporary cache, so neither
the source directory nor the packaged `native/` asset directory accumulates
toolchain intermediates.

The minimal regression test was written before the emitter option existed. It
first failed at the public `TranspileOptions` boundary, then covered the exact
lowered loop and console call. The runnable sample remains broad coverage, and
the decisive validation compiled and ran the produced executable.

A second validation deliberately allocated a runtime string. The numeric-only
sample linked successfully, but the string program initially failed with an
undefined `EnsureGCInfoIndex` symbol. CMake's Oilpan target exposes cppgc compile
definitions as `PUBLIC`; a direct `g++` consumer does not inherit target
properties. Passing `CPPGC_IS_STANDALONE`,
`CPPGC_ENABLE_OBJECT_SECTION_GCINFO`, and `V8_LOGGING_LEVEL` to the final
translation unit fixed the mismatch. A pure argument-builder regression now
keeps those consumer definitions visible.

The first object-oriented native sample exposed a second backend boundary:
JavaScript class calls are normally rewritten to `new` using analysis context,
but the small C++ emitter owns its allocation model. Primary-constructor
classes are now emitted as `cppgc::GarbageCollected<T>` objects, constructor
calls allocate through `Runtime::make<T>`, and known GC object locals use C++
pointer member access. Keeping allocation behind the runtime avoids embedding
heap-handle mechanics at every generated call site.

The first generated range loop also revealed a type-erasure shortcut: its
initializer was always declared as `double`, even though VexaScript already
distinguishes `int`, `long`, and `number`. The lowering pass preserves the
original range-bound expression nodes, so the C++ backend can consume the same
analysis type map as the JavaScript backend. Native loops now map `int` to
`std::int32_t`, `long` to `std::int64_t`, and `number` to `double`; AST literal
kinds remain only a fallback when no analyzed type is available.

## Investigation notes and rejected paths

Putting source extraction and `g++` directly in the transpiler would have been
shorter, but it would introduce Node APIs into a compiler module used by browser
embeds. It was rejected in favor of a compiler/backend boundary plus a
Node-only CLI build adapter.

Generating an absolute include path to `native/runtime.cpp` would make a local
build work but would make emitted C++ machine-specific. Generated code instead
includes `runtime.cpp` by name, while the native linker supplies the packaged
`native` include directory.

Treating unsupported JavaScript constructs as pass-through C++ was also
rejected. The initial backend is deliberately small and reports a compilation
error for unsupported AST kinds; this avoids producing plausible-looking but
incorrect native programs.

## Regression risks

- New language lowering must stay backend-neutral when possible; adding a
  C++-only interpretation of an existing construct would reintroduce drift.
- Runtime-owned Oilpan roots must be destroyed before the `Runtime` heap. The
  generated `main` declares `Runtime` first so later values are destroyed first
  by C++ reverse destruction order.
- GC object member access currently relies on emitter knowledge of locals that
  are initialized directly from class calls. When assignments, returns, or
  object-valued fields are added, that knowledge should come from shared
  analysis types rather than growing more syntax-specific tracking.
- Packaged CLI releases must continue including both `native/runtime.cpp` and
  `native/oilpan-standalone-main.zip`.
