# Native Structural Interfaces And Strict Object Mode

## Status

* [ ] Proposed — begin after the forced-dynamic native baseline and nominal AST
  migration are stable.

## Context

TypeScript uses structural typing: a class or object can satisfy an interface
without spelling `implements`. Whole-program native compilation can see the
available classes and interfaces, so it can recover static C++ dispatch for
these implicit conformances instead of routing every interface access through a
dynamic property lookup.

The compatibility backend must still support genuinely dynamic code. For
example, `(value as MyInterface).myDeclaredProperty = 10` may receive an `any`
object that does not yet expose the interface shape. Native code needs a bounded
attachment mechanism before falling back to a completely dynamic property bag.

Long term, the compiler itself should compile in a strict native object mode
that rejects dynamic object-member additions and therefore needs no generated
`get`/`set`/`invoke` dispatch tables.

## Goal

Provide three explicit native object tiers: analyzer-proven structural interface
conformance with static C++ dispatch, compatibility attachments for typed access
to dynamic objects, and a final dynamic property bag only for operations that
cannot be typed. Add a strict mode that permits only the first tier and migrate
the compiler until it builds and roundtrips in that mode.

## Scope

* [ ] Compute structural class-to-interface conformance from the complete native
  program, including classes that do not explicitly declare `implements`.
* [ ] Emit compatible classes as C++ implementations of the corresponding
  generated interface contracts, or generate equivalent statically typed
  adapters when direct inheritance would create an invalid hierarchy.
* [ ] Preserve one object identity and correct Oilpan tracing across implicit
  interfaces, explicit interfaces, adapters, and derived classes.
* [ ] For casts from `any` to a known interface, first attempt a static/native
  interface cast. If it fails and compatibility mode permits mutation, attach a
  typed forwarding object to the receiver.
* [ ] Prefer one attachment per property or method when a whole-interface
  attachment would introduce collisions, partial-conformance ambiguity, or
  update-order edge cases.
* [ ] Define one dynamic lookup order: concrete class members, typed attachments,
  then the fully dynamic property bag. Reuse it for get, set, and invoke.
* [ ] Add a strict native compilation mode that rejects operations requiring
  typed attachments or the dynamic property bag.
* [ ] Reject reflective object-shape operations in strict mode, including
  `"property" in object`, computed property-existence checks, dynamic key
  enumeration, and equivalent APIs whose result depends on runtime-added
  members. This restriction does not apply to dedicated collection membership
  APIs such as `Map.has` or `Set.has`.
* [ ] In strict mode, omit generated dynamic get/set/invoke registration and
  remove the corresponding runtime tables and reflective shape metadata from
  the produced executable.
* [ ] Track strict-mode diagnostics as compiler migration work rather than
  silently falling back to dynamic dispatch.
* [ ] Refactor the VexaScript compiler incrementally until its own native build
  succeeds in strict mode.

## Acceptance Criteria

* [ ] A class with no explicit `implements` clause can be passed to a compatible
  interface and uses static C++ interface dispatch.
* [ ] Multiple unrelated classes that satisfy the same interface can be called
  through that interface without dynamic property lookup.
* [ ] Compatibility mode preserves `(any as Interface).member = value` through
  a traced attachment when no direct interface cast is available.
* [ ] Concrete members take precedence over attachments, and attachments take
  precedence over the untyped dynamic property bag.
* [ ] Strict mode reports every required dynamic object operation and produces
  no dynamic get/set/invoke tables or reflective object-shape metadata when the
  program is accepted.
* [ ] The compiler passes at least two native self-host roundtrips in strict mode.

## Tests

* [ ] Extend the complete forced-dynamic/optimized native smoke with implicit
  structural interface conformance and attachment precedence cases.
* [ ] Run the smoke in compatibility and strict modes.
* [ ] Run two strict-mode native compiler roundtrips.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `compiler/analysis/`
* `compiler/runtime/cppEmitter.ts`
* `native/runtime.cpp`
* `samples/native-language-smoke/`
* `docs/tasks/specialize-native-cpp-emission.md`
* `docs/tasks/accelerate-native-self-host-iterations.md`
