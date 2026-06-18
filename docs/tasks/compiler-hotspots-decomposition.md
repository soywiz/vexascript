# Compiler Hotspots Decomposition

## Status

* [ ] Technical debt
* [~] In progress: CommonJS-specific import/export emission was extracted from `compiler/runtime/emitter.ts` into `compiler/runtime/commonJsEmitter.ts` with helper-level tests, reducing one module-format responsibility slice from the generic emitter path.

## Context

The compiler is functionally strong and well-covered by tests, but several core modules now concentrate too many responsibilities:

* `compiler/analysis/TypeChecker.ts` is one of the largest handwritten source files in the repository.
* `compiler/parser/parser.ts` is also very large and continues to absorb new syntax forms.
* `compiler/runtime/emitter.ts` and `compiler/runtime/moduleGraph.ts` now carry more module-format and bundling behavior than they originally did.

This is not a correctness problem right now. The project is stable and the test suite is strong. The debt is maintainability, reviewability, and change risk.

## Why This Is Debt

Large compiler modules increase the cost of every future feature:

* It becomes harder to see ownership boundaries.
* Small syntax or semantic changes touch unrelated logic.
* New contributors need more time to orient themselves.
* Bugs are more likely to be fixed locally instead of in shared abstractions.
* Test coverage remains good, but causal reasoning becomes harder.

## Current Hotspots

### Type checking

`compiler/analysis/TypeChecker.ts` currently mixes:

* Declaration collection and registration
* Expression/type inference
* Control-flow validation
* async/sync/auto-await semantics
* class/interface/enum validation
* import-shadowing and imported-binding diagnostics
* JSX-specific checks

### Parsing

`compiler/parser/parser.ts` currently mixes:

* statement parsing
* declaration parsing
* TypeScript compatibility forms
* Vexa-specific syntax
* JSX parsing
* recovery behavior

### Emission and module preparation

`compiler/runtime/emitter.ts` and `compiler/runtime/moduleGraph.ts` currently mix:

* syntax emission
* module-format emission (`esm` / `commonjs`)
* implicit export planning
* Vexa-specific runtime name mapping
* local module graph preparation
* bundling-oriented source shaping

## Desired End State

Keep the same external behavior, but reduce responsibility concentration by extracting smaller, explicit subsystems.

Examples of likely seams:

* type-checker declaration collection vs. statement/expression checking
* callable resolution / overload selection helpers
* async/sync/auto-await rules
* class/interface contract validation
* parser syntax families by area
* emitter module-format emission helpers
* module-graph export planning and bundling preparation

## Suggested Tasks

* [x] Map the internal responsibility slices inside `TypeChecker.ts` and extract the easiest read-only helpers first.
  - Identified 6 pure private methods (no `this`-state dependency): `typeToDiagnosticLabel`, `isNumberLikeType`, `normalizePropertyName`, `normalizeIndexSignaturePropertyName`, `isDynamicPropertyName`, `propertyNamesMatch`.
  - Extracted into two new focused modules: `compiler/analysis/typeDisplay.ts` (type formatting + numeric predicate) and `compiler/analysis/propertyNames.ts` (property name normalization and matching). Both have full unit-test coverage.
  - TypeChecker.ts now imports these as standalone functions; 26 call sites updated.
  - Second batch: extracted 5 more pure helpers — `isAsyncLike`, `statementAllowsLabeledContinue`, `statementListPreventsSwitchFallthrough`, `statementPreventsSwitchFallthrough` into `compiler/analysis/controlFlow.ts`, and `tupleElementTypeText` added to `compiler/analysis/typeNames.ts`. All covered by `compiler/analysis/controlFlow.test.ts` (28 tests).
  - Third batch: extracted 9 type predicate functions into `compiler/analysis/typeClassifiers.ts` (64 tests including new property helpers). Expanded `compiler/analysis/propertyNames.ts` with 4 property type access helpers (`propertyEntries`, `propertyTypeFrom`, `propertyTypeAllowsUndefined`, `propertyTypeWithoutUndefined`). TypeChecker.ts now imports 40+ standalone functions.
  - Fourth batch: extracted pure type annotation text parsers (`parseFunctionTypeAnnotation`, `parseObjectTypeAnnotation`, `looksLikeFunctionTypeAnnotation`) from TypeChecker.ts into `compiler/analysis/typeNames.ts`. 14 new tests added to `compiler/analysis/typeNames.test.ts`.
  - Fifth batch: extracted `statementAlwaysExits` and `statementListAlwaysExits` from TypeChecker.ts into `compiler/analysis/controlFlow.ts`. 23 new tests added to `compiler/analysis/controlFlow.test.ts` (now 51 tests total).
* [ ] Separate statement-family checking from shared type/call resolution helpers.
* [ ] Split parser logic by syntax families where it reduces branching without duplicating token flow.
* [x] Reduce the amount of bundling-specific logic living inside generic emission paths.
  - Extracted three pure bundling-stripping helpers (`stripBundledImports`, `stripBundledModuleSyntax`, `stripBundledCommonJsImports`) from `moduleGraph.ts` into `compiler/runtime/bundlingStripping.ts` with 15 unit tests. `moduleGraph.ts` now imports them from the new module.
* [x] Add narrow unit tests for newly extracted helpers before moving larger blocks.
  - `compiler/analysis/typeDisplay.test.ts` and `compiler/analysis/propertyNames.test.ts` cover all extracted functions.
  - `compiler/analysis/controlFlow.test.ts` covers all control-flow predicates.
* [x] Keep behavior-preserving refactors separate from feature work whenever possible.
  - All extraction commits above are pure refactors: same external behavior, tests unchanged, only new test files added.
