# Expand The Native Standard Library

## Status

* [x] Completed

## Context

Native builds expose a useful but narrow subset of Array, String, Object, Math,
RegExp, Promise, and primitive conversion APIs. Important ECMAScript collections,
binary-data types, date/time behavior, JSON support, and many common methods are
still absent.

## Goal

Provide a coherent native standard-library surface that follows the ambient
runtime declarations and routes related APIs through canonical runtime classes.

## Scope

* [x] Maintain an explicit parity inventory against `compiler/runtime/es2025.d.ts`.
* [x] Complete common Array methods, including `find`, `at`, `splice`, `flat`,
  `flatMap`, iterators, and missing search/copy operations.
* [x] Expand String, Number, Math, Object, and RegExp behavior.
* [x] Implement `Map`, `Set`, `WeakMap`, and `WeakSet` with trace-safe managed
  references where required.
* [x] Implement `JSON.parse` and `JSON.stringify` for supported dynamic values.
* [x] Implement Date construction, timestamps, comparison, and common formatting.
* [x] Implement `ArrayBuffer`, typed arrays, `DataView`, and binary conversions.
* [x] Keep visible Array behavior on `ArrayObject<T>` instead of accumulating
  method-specific emitter semantics.
* [x] Use shared declaration/member resolution to select runtime APIs rather than
  growing unrelated name-based special cases.

## Acceptance Criteria

* [x] The supported native API subset is generated or audited against ambient
  declarations and documented precisely.
* [x] Collection mutations preserve reference identity and GC reachability.
* [x] JSON and binary-data behavior has deterministic cross-backend output tests.
* [x] Unsupported standard-library calls produce targeted diagnostics.

## Tests

* [x] Add focused runtime tests for every new API family.
* [x] Add native compile-and-run collection, JSON, Date, and binary-data tests.
* [x] Extend `samples/native-language-smoke/` only with representative API flows.
* [x] Run `pnpm test`.
* [x] Run `pnpm cli vexa testFixtures/sample.vx`.

## Completion Summary

The documented native subset now covers the common Array/String/Number/Math/
Object/RegExp surface plus managed maps/sets, JSON, Date, ArrayBuffer, Uint8Array,
DataView floats and integers, and dependency-free bigint. Array behavior remains
owned by `ArrayObject<T>`, and the smoke compares representative JSON, binary,
date, collection, unicode, and bigint behavior across backends.

## Related Files

* `compiler/runtime/es2025.d.ts`
* `compiler/runtime/cppEmitter.ts`
* `native/runtime.cpp`
* `docs/native.md`
* `docs/syntax.md`
