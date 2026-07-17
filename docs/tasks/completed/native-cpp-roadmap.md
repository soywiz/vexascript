# Complete The Native C++ Backend

## Status

* [x] Completed

## Context

The native C++ backend now covers functions, classes, interfaces, operators,
managed arrays and records, arbitrary-precision bigint values, control flow,
exceptions, generators, promises, timers, and dependency-ordered local modules.
The completed roadmap covered language specialization, module identity, the
dynamic value model, runtime APIs, async integration, and production tooling.

## Goal

Track the remaining high-value native work as independently testable tasks while
keeping semantic decisions shared with analysis and JavaScript emission.

## Work Tracks

Recommended implementation order:

1. [x] [Support Generics In Native C++](native-cpp-generics.md)
2. [x] [Complete Native Module And Package Support](native-cpp-modules-and-packages.md)
3. [x] [Expand The Native Dynamic Value Model](native-cpp-dynamic-values.md)
4. [x] [Expand The Native Standard Library](native-cpp-standard-library.md)
5. [x] [Complete The Native Async Runtime](native-cpp-async-runtime.md)
6. [x] [Complete Remaining Native Language Semantics](native-cpp-language-completeness.md)
7. [x] [Harden Native Builds For Production](native-cpp-production-hardening.md)

Some tracks can proceed in parallel, but dynamic callable values are a dependency
for structural object methods, and generic specialization is a dependency for a
large part of the standard-library surface.

## Shared Acceptance Criteria

* [x] Native semantics consume analyzer resolution instead of repeating type,
  overload, implicit-receiver, or assignability decisions in the C++ emitter.
* [x] Unsupported cases continue producing explicit diagnostics rather than
  plausible but incorrect C++.
* [x] Every completed work track adds focused tests and executable coverage where
  behavior can only be validated after C++ compilation and linking.
* [x] `samples/native-language-smoke/` continues matching its JavaScript and
  native expected output files.
* [x] `pnpm test` passes after every completed track.
* [x] `pnpm cli vexa testFixtures/sample.vx` passes after every completed track.

## Completion Summary

All seven native work tracks are complete and archived under `docs/tasks/completed/`.
The backend now has analyzer-driven generic and language semantics, local/package
module compilation, one trace-safe dynamic model, an audited standard-library
subset, a unified async runtime, and production validation covering source
locations, packaged consumers, sanitizer/GC stress, bigint differentials, and
recorded benchmarks.

## Related Files

* `compiler/runtime/cppEmitter.ts`
* `compiler/runtime/nativeModuleGraph.ts`
* `native/runtime.cpp`
* `native/bigint.h`
* `cli/nativeBuild.ts`
* `samples/native-language-smoke/`
* `docs/native.md`
