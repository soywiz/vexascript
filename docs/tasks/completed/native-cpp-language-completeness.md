# Complete Remaining Native Language Semantics

## Status

* [x] Completed

## Context

The C++ emitter intentionally rejects unsupported syntax. The largest remaining
language gaps concern constructor forwarding, interface forms, destructuring,
runtime type checks, labeled control flow, and object methods. Some depend on the
generic or dynamic-value tasks, but their source semantics should remain owned by
shared analysis and lowering.

## Goal

Close the remaining high-value syntax and object-model gaps without creating
backend-specific semantic analysis.

## Scope

* [x] Represent and emit base-constructor arguments through `super(...)`.
* [x] Remove the requirement that every generated base class have a default
  constructor.
* [x] Support optional interface members and multiple interface inheritance.
* [x] Integrate generic interfaces through the native generics task.
* [x] Integrate object-literal methods through the dynamic-value task.
* [x] Support destructuring defaults, object rest, nested rest, and destructuring
  bindings in `for-of` loops.
* [x] Support analyzer-resolved `is`, `instanceof`, and remaining `in` cases for generated native objects, interfaces, arrays, and records.
* [x] Support labeled `break` and `continue` through shared completion lowering.
* [x] Audit every remaining `CppEmitError` rejection and classify it as supported,
  intentionally unsupported, or owned by another active native task.
* [x] Keep implicit `this`, overload, and operator resolution shared with the
  JavaScript backend through analyzer-produced semantic maps.

## Acceptance Criteria

* [x] Derived classes can forward non-default constructor arguments safely.
* [x] Supported interface inheritance and optional-member behavior agree with
  semantic assignability.
* [x] Destructuring forms preserve evaluation order and single evaluation.
* [x] Runtime type checks and labeled control flow match JavaScript-observable
  behavior for supported native types.
* [x] `docs/native.md` contains an up-to-date explicit rejection inventory.

## Tests

* [x] Add focused emitter tests for each newly supported syntax form.
* [x] Add native compile-and-run tests for constructor forwarding and cleanup
  through labeled control flow.
* [x] Add cross-backend destructuring and runtime-type-check output tests.
* [x] Run `pnpm test`.
* [x] Run `pnpm cli vexa testFixtures/sample.vx`.

## Completion Summary

Native classes forward explicit `super(...)` constructor arguments, interfaces
support optional members and inheritance, destructuring covers lazy defaults and
rest forms, and labeled completion crosses nested control flow correctly. Runtime
type checks, implicit receivers, overloads, extensions, and operators consume
analysis-owned semantic maps, with remaining exclusions listed in `docs/native.md`.

## Related Files

* `compiler/ast/ast.ts`
* `compiler/analysis/TypeChecker.ts`
* `compiler/runtime/lowering.ts`
* `compiler/runtime/cppEmitter.ts`
* `docs/native.md`
* `docs/syntax.md`
