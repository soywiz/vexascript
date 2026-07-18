# Specialize Native C++ Emission For Proven Static Cases

## Status

* [ ] Active

## Context

The correctness baseline emits values, properties, and calls through the dynamic
runtime. Once the full smoke is green, analyzer facts can be used to replace
selected dynamic operations with direct C++ without changing their semantics.
Previous native work mixed inference and emission decisions in many independent
branches, which made the optimized and dynamic paths drift.

## Goal

Generate optimal direct C++ for statically proven cases while retaining the
dynamic runtime as the sole semantic fallback and oracle.

This phase starts only after the forced-dynamic smoke is correct. It precedes
the final native self-host roundtrips so the resulting compiler can use direct
field access and direct calls where the analyzer has proved them safe.

## Scope

* [ ] Define explicit proof conditions for unboxed primitives, direct fields,
  direct methods, typed arrays, typed collections, and monomorphic callbacks.
* [ ] Centralize specialization decisions so implicit `this`, interfaces,
  overloads, optional values, and calls are not re-derived by the emitter.
* [ ] Introduce fast paths one category at a time, always falling back to the
  canonical dynamic operation when proof is incomplete.
* [ ] Compare optimized and forced-dynamic executions of the same smoke program.
* [ ] Track compile-time and generated-code-size costs as well as runtime speed.
* [ ] Continue the object specialization work in
  `native-structural-interfaces-and-strict-mode.md`: infer implicit structural
  interface implementations, retain typed attachments as the compatibility
  tier, and ultimately compile the compiler without dynamic member dispatch.

## Acceptance Criteria

* [ ] Forced-dynamic and optimized native builds produce identical smoke output.
* [ ] Every specialization has a documented analyzer-owned proof condition.
* [ ] Removing a fast path leaves a correct dynamic program rather than an
  unsupported-language diagnostic.
* [ ] Benchmarks justify each retained specialization.

## Tests

* [ ] Run the complete smoke in forced-dynamic and optimized modes.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `compiler/analysis/`
* `compiler/runtime/cppEmitter.ts`
* `native/runtime.cpp`
* `samples/native-language-smoke/`
