# Expand The Native Dynamic Value Model

## Status

* [x] Completed

## Context

`vexa::Value` currently represents undefined, null, booleans, numbers, bigint,
managed strings, and records. Arrays, functions, closures, generated objects,
and interface references cannot yet flow uniformly through `any`, unions, mixed
containers, record properties, or callable structural interfaces.

## Goal

Represent every important runtime value through one trace-safe dynamic contract
without losing array reference identity or generated-object dispatch.

## Scope

* [x] Add a type-erased, traceable dynamic array representation while preserving
  the canonical `ArrayObject<T>` storage and reference semantics.
* [x] Add dynamic generated-class and interface references with correct Oilpan
  tracing and virtual dispatch.
* [x] Add function and closure values with argument conversion and return-value
  adaptation.
* [x] Store callable values in records and mixed containers.
* [x] Support object-literal methods through the same callable representation.
* [x] Support structural record adaptation for interfaces containing methods.
* [x] Define exact dynamic equality, truthiness, string conversion, property-key,
  arithmetic, and type-query behavior for every new variant.
* [x] Preserve nested and cyclic arrays, records, objects, and closures under GC.
* [x] Avoid parallel value representations for arrays or functions.

## Acceptance Criteria

* [x] Arrays and generated objects can round-trip through `any` without copying
  storage or losing identity.
* [x] A function stored in a variable, record, array, or interface property can be
  called natively.
* [x] Two structural objects implementing the same callable interface dispatch
  through that interface correctly.
* [x] Cycles involving every dynamic variant become collectible after the last
  reachable owner disappears.

## Tests

* [x] Add focused conversion and dispatch tests for every `Value` variant.
* [x] Add native identity and mutation tests for dynamically stored arrays.
* [x] Add Oilpan collection stress tests for dynamic cycles and captured closures.
* [x] Extend the native executable smoke with callable structural objects.
* [x] Run `pnpm test`.
* [x] Run `pnpm cli vexa testFixtures/sample.vx`.

## Completion Summary

`vexa::Value` now covers primitives, bigint, strings, records, arrays, generated
objects/interfaces, and functions through one traced contract. Dynamic
conversions preserve array/object identity; callable structural interfaces share
the same dispatch path; equality, truthiness, arithmetic, keys, stringification,
and type queries have focused coverage. Function objects own only their actually
referenced captures as `StoredValue` edges, and a finalization test proves that a
record/array/object/closure cycle is collected after its last root disappears.

## Related Files

* `native/runtime.cpp`
* `compiler/runtime/cppEmitter.ts`
* `compiler/analysis/types.ts`
* `samples/native-language-smoke/`
