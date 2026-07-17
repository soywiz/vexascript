# Support Generics In Native C++

## Status

* [x] Completed

## Context

Semantic analysis understands generic declarations and resolves many specialized
call-site types, but native emission still rejects generic functions, methods,
classes, interfaces, and extensions. This prevents ordinary reusable VexaScript
code and much of the declared standard library from compiling natively.

## Goal

Emit type-safe native specializations from analyzer-resolved generic uses without
reimplementing inference or overload selection in the C++ backend.

## Scope

* [x] Define one native specialization model and stable mangling scheme.
* [x] Emit generic free-function specializations, including recursion.
* [x] Emit generic class and constructor specializations.
* [x] Emit generic instance and static method specializations.
* [x] Emit generic extension function and property specializations.
* [x] Support generic interfaces and conformance after concrete substitution.
* [x] Preserve constraints, defaults, nested type arguments, arrays, promises,
  generators, generated objects, and bigint types through substitution.
* [x] Reuse analyzer-selected type arguments for explicit and inferred calls.
* [x] Deduplicate identical specializations across call sites and local modules.
* [x] Diagnose open or unsupported generic shapes explicitly.

## Acceptance Criteria

* [x] Generic declarations used with multiple concrete types produce distinct,
  correctly typed native specializations.
* [x] Generic classes preserve GC tracing for specialized managed fields.
* [x] Generic overload resolution agrees with JavaScript emission and analysis.
* [x] Cross-module generic calls do not emit duplicate or conflicting symbols.

## Tests

* [x] Add focused C++ emitter tests for every generic declaration kind.
* [x] Add native compile-and-run tests for nested and recursive specialization.
* [x] Extend `samples/native-language-smoke/` with a realistic generic workflow.
* [x] Run `pnpm test`.
* [x] Run `pnpm cli vexa testFixtures/sample.vx`.

## Completion Summary

Native generics use C++ templates with analyzer-selected substitutions for free
functions, recursion, classes, methods, interfaces, and extensions. Constraint,
default, nested managed, promise, generator, and bigint shapes have focused
emitter coverage and execute in the native language smoke and module graph.

## Related Files

* `compiler/analysis/TypeChecker.ts`
* `compiler/analysis/types.ts`
* `compiler/runtime/cppEmitter.ts`
* `compiler/runtime/operatorNames.ts`
* `compiler/runtime/nativeModuleGraph.ts`
