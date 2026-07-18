# Optimize Complex Native Dynamic Operations

## Status

* [ ] Active

## Context

The native backend is being rebuilt around one correctness-first dynamic
`vexa::Value` protocol. Property access, mutation, calls, collections, closures,
and structural objects must share that path before specialization is reintroduced.
The canonical dynamic path may initially allocate wrappers, repeat lookups, or
perform conversions that are intentionally simple rather than fast.

## Goal

Improve the performance of dynamic and semantically complex native operations
without creating a second behavior model or weakening the executable smoke test.

## Scope

* [ ] Profile dynamic property lookup, bound-method creation, calls, collection
  operations, closure captures, Promise scheduling, and structural dispatch.
* [ ] Cache or specialize runtime metadata only when invalidation and object
  mutation remain correct.
* [ ] Reduce temporary `Value`, argument-vector, function-wrapper, and property-key
  allocations on hot paths.
* [ ] Preserve array/object identity and Oilpan tracing while optimizing dynamic
  containers and callable values.
* [ ] Keep one canonical runtime operation for each language semantic.

## Acceptance Criteria

* [ ] The complete native language smoke produces exactly the same output before
  and after each optimization.
* [ ] Benchmarks demonstrate a measurable improvement in the targeted dynamic
  operation.
* [ ] No optimization adds emitter-side semantic reconstruction or parallel
  property/call behavior.

## Tests

* [ ] Run the complete native language smoke.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `native/runtime.cpp`
* `compiler/runtime/cppEmitter.ts`
* `samples/native-language-smoke/`

