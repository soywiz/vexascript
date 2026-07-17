# Harden Native Builds For Production

## Status

* [x] Completed

## Context

The native smoke validates a broad program end to end, but production readiness
also requires debuggability, clean compiler output, runtime stress coverage,
portable packaged artifacts, sanitizer runs, and performance work. The current
dependency-free bigint prioritizes correctness and uses deliberately slow
bit-at-a-time division.

## Goal

Make native executables diagnosable, portable, memory-safe under stress, and
measurably performant without weakening semantic regression coverage.

## Scope

* [x] Emit source-level debug metadata or a generated-to-source mapping usable in
  native stack traces and diagnostics.
* [x] Preserve thrown values, source context, and useful stack information.
* [x] Eliminate generated C++ warnings, including false missing-return paths.
* [x] Add AddressSanitizer and UndefinedBehaviorSanitizer native test modes.
* [x] Stress Oilpan cycles across arrays, records, classes, interfaces, closures,
  promises, tasks, and generators.
* [x] Test long-running timers, cancellation, shutdown, large allocations, and
  exception paths during coroutine destruction.
* [x] Add native CI coverage for supported macOS/Linux architectures and define a
  Windows support decision.
* [x] Verify published packages contain every native header, runtime source, and
  Oilpan artifact required by `cpp` and `executable`.
* [x] Add native compile-time, binary-size, startup, event-loop, array, GC, and
  bigint benchmarks with recorded baselines.
* [x] Optimize bigint multiplication and division after benchmarks identify useful
  thresholds; add prefixed-string parsing such as `BigInt("0xff")`.

## Acceptance Criteria

* [x] Sanitized native smoke and focused GC stress programs pass without leaks,
  invalid accesses, or undefined behavior.
* [x] Generated C++ compiles without warnings in the currently tested native toolchain.
* [x] Native failures report actionable source locations.
* [x] A packed release can generate and link an executable outside the repository.
* [x] Bigint optimizations preserve all signed arithmetic and bitwise regressions.
* [x] Benchmark changes are reviewed against checked-in or CI-recorded baselines.

## Tests

* [x] Add sanitizer and GC-stress test commands suitable for CI.
* [x] Add package-content and installed-package executable tests.
* [x] Add source-mapping and native error-reporting tests.
* [x] Add differential bigint tests against JavaScript `BigInt`.
* [x] Run `pnpm test`.
* [x] Run `pnpm cli vexa testFixtures/sample.vx`.

## Completion Summary

Native builds now expose source-mapped failures, sanitizer and forced-GC modes,
macOS/Linux CI, package-content and packed-consumer execution tests, and recorded
compile/size/startup/runtime baselines. Deterministic differential tests compare
large signed bigint arithmetic and bitwise operations with JavaScript. The
baseline did not identify a multiplication/division threshold that justified
replacing the simple dependency-free implementation; prefixed parsing was added
without speculative optimization.

## Related Files

* `compiler/runtime/cppEmitter.ts`
* `native/runtime.cpp`
* `native/bigint.h`
* `cli/nativeBuild.ts`
* `cli/nativeSmoke.test.ts`
* `.github/workflows/tests.yml`
* `package.json`
* `docs/native.md`
