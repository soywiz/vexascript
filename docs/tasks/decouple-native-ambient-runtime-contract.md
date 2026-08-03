# Decouple The Native Runtime From Ambient Method Mapping

## Status

* [ ] Active

## Context

The native emitter still contains special cases that recognize ambient method
names and translate them to C++ helpers. This makes the emitter and
`native/runtime.cpp` a private pair: adding an ambient declaration or another
native backend requires knowing the emitter's method-name tables and branches.

The runtime also uses templated `ArrayObject<T>`, `MapObject<K, V>`, and
`SetObject<T>` types as the representation of JavaScript containers. Those
templates are useful for native storage, but they leak an optimization detail
into the JavaScript container contract even though JavaScript arrays and maps
are heterogeneous at runtime.

## Goal

Make ambient declarations the source of truth for native call names and
signatures. A statically resolved ambient member should generate a call using
the same operation name that the runtime contract exposes, without a
method-name mapping branch in the emitter.

Separate the JavaScript container representation from optional typed native
storage so arrays and maps remain semantically heterogeneous while the runtime
can still specialize proven internal workloads.

## Scope

* [x] Define one declaration-driven native member contract for instance and
  static ambient APIs. Remove emitter branches whose only purpose is renaming
  an ambient operation to a helper with a different name. The static contract
  now discovers ambient globals from declarations and forwards ordinary calls
  through `vexa::ambient::<global>::<member>`, including contextual Promise
  APIs. Keep `process` as an explicit platform object because its native
  lifetime is tied to the generated program's host process instance.
* [ ] Make ordinary ambient array members resolve directly against the runtime
  contract. Introduce a non-templated JavaScript array representation storing
  `Value` (or an equivalently named `JsArray`) and move typed sequence storage
  behind a separate internal/native abstraction.
* [ ] Apply the same separation to `Map`, `Set`, `WeakMap`, and `WeakSet`:
  their JavaScript-facing contract must support heterogeneous `Value` keys and
  values, while any typed indexes or vectors remain implementation details.
  For `Map`, migrate static `groupBy` and all instance members through the
  ambient contract before changing storage, then replace the current typed
  `MapObject<K, V>` representation with a `Value`-backed JavaScript-facing
  boundary and retain typed maps only behind explicit native specialization.
  Add regressions for mixed key/value types, object keys, and callbacks that
  return different key types across calls.
* [ ] Keep typed binary objects (`Uint8Array`, `Uint32Array`, `BigInt64Array`,
  `Float16Array`, `ArrayBuffer`, and `DataView`) as separate native contracts;
  they are not ordinary JavaScript arrays and must not be forced through the
  dynamic array representation.
* [ ] Keep genuinely dynamic operations (a method read from a `Value`, a
  computed property, or an unproven structural call) on one dynamic dispatch
  path. Do not replace those semantic cases with static name guessing.
* [ ] Define the conversion boundary explicitly. `Value` may convert to a
  string only with the existing checked string semantics; arbitrary JavaScript
  coercion must remain an explicit runtime operation. Audit implicit C++
  conversions for overload ambiguity and hidden GC allocation.
* [ ] Verify that callbacks stored in dynamic containers retain their GC roots
  for as long as the container can invoke them, and that removing the last
  reference permits collection without a stale callback.
* [ ] Remove obsolete helper aliases and update tests to assert the ambient
  contract rather than the retired mapping layer.

## Completed In The Current Slice

* `Object`, `Map.groupBy`, and the ordinary ES runtime static families now use
  declaration-discovered ambient receivers in the C++ emitter.
* Static ambient properties such as `Math.PI` and operator lowerings such as
  numeric exponentiation use the same ambient runtime namespace; they no
  longer reach the legacy `vexa::Math` implementation directly.
* `Promise` static methods use the same ambient route. Runtime wrappers derive
  task/value handling from C++ templates; the emitter does not translate
  Promise method names to helper names.
* Promise instance continuations now belong to the native `Task<T>` contract:
  generated code calls `.then`, `.vexa_catch`, and `.finally` directly after
  the generic C++ keyword escape. Callback result context is inferred from the
  resulting `Task` type, without selecting a helper from the method name.
* The remaining `process` and `console` cases are documented platform
  operations. Promise instance continuation methods now use the direct
  `Task<T>` contract. `Intl.DurationFormat` construction remains contextual
  because it needs duration-object adaptation, while its instance methods and
  nested static `supportedLocalesOf` call use the declared operation names.
* `TextEncoder` construction and `encode`/`encodeInto`, growable
  `ArrayBuffer` methods, and generator `next`/`return` now use direct native
  contracts. The emitter only handles their representation-specific
  construction or C++ keyword escaping; it does not map those ambient method
  names to free helpers.
* Transpile analysis includes the embedded ECMAScript declarations, and the
  type checker resolves uniquely qualified nested declaration names. Nested
  static ambient calls therefore remain type-safe instead of requiring an
  emitter fallback for an `unknown` receiver.

## Map-specific Follow-up Tasks

These are deliberately separate from ambient method-name decoupling. The
native emitter can now emit `Map.get`, `Map.set`, `Map.has`, `Map.delete`,
`Map.keys`, and `Map.groupBy` using the declared operation names, but the
runtime storage still has typed `MapObject<K, V>` specializations.

* [ ] Introduce a `Value`-backed JavaScript-facing map boundary for ordinary
  `Map` and `ReadonlyMap` values.
* [ ] Keep typed maps only as explicit native/internal specializations, with
  conversions at the boundary rather than in generated ambient calls.
* [ ] Add native regressions for mixed key/value types, object identity keys,
  and callbacks whose returned key type varies between invocations.
* [ ] Repeat the boundary audit for `WeakMap` and `WeakSet`, including GC
  lifetime tests for keys, values, and callbacks.

## Acceptance Criteria

* [ ] The static native emitter has no method-name table or equivalent branch
  for ordinary ambient array, string, iterator, map, set, weak-map, or weak-set
  members.
* [ ] Generated C++ for representative ambient calls uses the ambient
  operation name directly, including `concat`, `reduce`, `take`, `drop`,
  `replace`, `repeat`, `Map.get`, `Map.set`, `Set.add`, and `Set.union`.
* [ ] Heterogeneous arrays and maps compile and run correctly in native code;
  typed native specializations remain behaviorally correct where they are
  deliberately retained.
* [ ] Dynamic member calls continue to work through the single dynamic path,
  including computed names and callbacks.
* [ ] Callback lifetime and GC-stress tests demonstrate both safe invocation
  and collection after the final owning reference disappears.
* [ ] The residual hardcoded branches in the emitter are documented as
  constructors, syntax lowerings, dynamic dispatch, contextual async/object
  lowerings, or genuinely non-ambient platform operations rather than name
  mappings.

## Residual Branch Classification

The remaining property-name checks are intentionally outside the ordinary
ambient forwarding contract:

* `process.cwd` and `console.log`/`info`/`warn`/`error` are host-platform
  operations with process lifetime and output-stream semantics.
* `Intl.DurationFormat` construction normalizes a native duration object, so
  construction remains contextual object lowering. Its `format`,
  `formatToParts`, `resolvedOptions`, and `supportedLocalesOf` operations are
  declaration-driven direct calls.
* `ArrayBuffer`/typed-array accessors, generator result access, `super`, and
  spread packing are representation or syntax lowerings.
* `PromiseWithResolvers` exposes its `promise` value and callable members
  directly on the native resolver object. The Promise continuation methods use
  the type-directed `Task<T>` path and contain no method-name dispatch.

## Tests

* [x] Add focused C++ emitter tests for declaration-driven ordinary members and
  heterogeneous array/map arguments.
* [ ] Add native compile-and-run coverage for heterogeneous arrays,
  `Map`/`Set`/weak collections, iterator methods, and callback lifetime under
  GC stress.
* [ ] Run `pnpm test:native`.
* [x] Run `pnpm test`.
* [x] Run `pnpm cli vexa testFixtures/sample.vx`.

The current native run is intentionally left unchecked: it passes 54/58 tests
and is blocked by the failures listed below.

## Current Blockers

The focused ambient-contract slice is green, but the complete native suite is
not yet green. The latest `pnpm test:native` run passes 54/58 tests and leaves
these follow-up tasks:

* [ ] Make the native compiler self-host compile without `Value` to internal
  type-pointer casts or incompatible `ArrayObject<T>` specializations.
* [ ] Fix the value-producing `match` smoke case so dynamic object properties
  use the declared dynamic contract instead of failing at runtime.
* [ ] Fix the complete native language smoke's remaining generated-call and
  member-shape failures, including interface delegation, optional/default
  arguments, generator value/reference syntax, and dynamic record members.
* [ ] Re-run the native CLI bundle smoke after the self-host compiler build is
  clean.

The deterministic native matrix, including `Object.groupBy` and
`Map.groupBy`, passes independently. These blockers are tracked here because
they are required before marking the broader decoupling task complete, but
they are not evidence that the `Map.groupBy` ambient wrapper itself is broken.

## Related Files

* `compiler/runtime/cppEmitter.ts`
* `compiler/runtime/cppEmitter.test.ts`
* `compiler/runtime/transpile.ts`
* `compiler/analysis/`
* `native/runtime.cpp`
* `docs/tasks/specialize-native-cpp-emission.md`
* `tests/native/nativeSmoke.native.ts`
