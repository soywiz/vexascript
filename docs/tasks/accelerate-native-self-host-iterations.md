# Accelerate Node Compiler And Native Self-Hosting Iterations

## Status

* [ ] Active — Node-side compiler throughput is the first optimization phase and
  must precede the dynamic C++ rebuild.

## Context

Compiling the compiler as one large C++ translation unit currently makes each
self-hosting experiment expensive. Slow TypeScript-to-VexaScript preparation,
native emission, generated C++ parsing, optimization, and linking all lengthen
the feedback loop and delay discovery of the next semantic failure.

## Goal

First make the compiler materially faster while it runs under Node, then make
native compilation fast enough for repeated roundtrips to be a practical
development loop.

## Scope

* [x] Measure time under Node for module loading, isolated analysis, merged
  analysis, and C++ emission. Memory plus native parsing, optimization, and
  linking remain to be measured.
  VexaScript emission, C++ emission, C++ parsing, optimization, and linking.
* [x] Optimize the highest-cost Node-side compiler phase before resuming the
  dynamic C++ backend work. Bounded immutable type-text caches and per-emission
  declared-type/closure caches reduced the 44-module transpile benchmark from
  about 42.5 seconds to about 15.5 seconds on 2026-07-17.
* [ ] Avoid repeated parsing, analysis, declaration collection, semantic-map
  construction, and generated-source preparation within one CLI invocation.
* [ ] Cache immutable standard-library and compiler-module preparation safely
  across files in the same process.
* [ ] Add progressive self-host fixtures so inexpensive stages fail before the
  full compiler translation unit is built.
* [ ] Investigate splitting generated C++ into stable runtime/module translation
  units with incremental compilation and reusable object files.
* [ ] Avoid regenerating or recompiling unchanged modules and runtime sources.
* [ ] Evaluate compiler-source simplifications that reduce generated C++ size or
  template pressure without distorting the compiler architecture.
* [ ] Evaluate a complete nominal AST migration: concrete AST node classes with
  typed constructors, a shared metadata base, native `instanceof`, and Oilpan
  inheritance/allocation designed for derived nodes. Do not use a partial
  `Object.setPrototypeOf` migration: the 2026-07-18 experiment increased parse
  time from about 266 ms to 407 ms and pre-emission time from about 9.1 seconds
  to 10.1 seconds, while interfaces extending the base class could not be
  represented by the current C++ interface model.
* [ ] Provide fast debug and syntax-validation profiles plus a separate final
  optimized roundtrip profile.

## Acceptance Criteria

* [ ] A reproducible benchmark reports the cost of every self-host stage. Set
  `VEXA_PROFILE_COMPILER=1` for the implemented Node-side phase report; native
  toolchain phases remain pending.
* [x] The Node-side compiler benchmark is materially faster than its recorded
  baseline without changing the generated program's behavior.
* [ ] An unchanged rerun reuses stable work and is materially faster than a cold
  roundtrip.
* [ ] Any nominal AST migration outperforms the structural AST under both Node
  and native execution and does not add a structural compatibility path.
* [ ] Progressive fixtures and the full compiler use the same native pipeline.
* [ ] At least two complete native compiler roundtrips remain output-equivalent.

## Tests

* [ ] Run progressive self-host fixtures before the full compiler roundtrip.
* [ ] Run two complete native compiler roundtrips.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `cli/nativeCompiler.vx`
* `cli/nativeBuild.ts`
* `compiler/runtime/nativeModuleGraph.ts`
* `compiler/runtime/cppEmitter.ts`
* `native/runtime.cpp`
