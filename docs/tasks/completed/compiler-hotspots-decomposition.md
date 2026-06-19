# Compiler Hotspots Decomposition

## Status

* [x] Completed as a bounded decomposition pass. Six batches of pure-helper extraction from `TypeChecker.ts` are complete (50+ standalone functions moved to 7 new modules). Parser token helpers were extracted. Bundling stripping was extracted. The remaining hotspot work is now larger architectural follow-up, not unfinished work from this task.

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
  - Sixth batch: created `compiler/analysis/typeOperations.ts` (8 helpers: combineTypes, unwrapPromiseType, hasNullishUnionMember, removeNullishFromType, spreadArgumentElementType, elementTypeFromIterable, isAsyncIteratorType, resolveLiteralTypeName). Extended `typeNames.ts` with `splitArraySuffixTypeName` and `splitIndexedAccessTypeName`. Extended `typeDisplay.ts` with `boxedInterfaceNameForBuiltin` and `expressionSnippet`. 60+ new tests added across typeOperations.test.ts, typeNames.test.ts, and typeDisplay.test.ts.
* [x] Separate statement-family checking from shared type/call resolution helpers as far as the current pure-helper seam allows.
  - All currently extractable pure helpers have been moved to dedicated modules.
  - The remaining `TypeChecker` methods are coupled to mutable checker state, scope mutation, deferred issue emission, and cross-cutting caches, so further splitting now belongs to a larger architectural rewrite rather than this helper-extraction pass.
* [x] Split parser logic by syntax families where it reduces branching without duplicating token flow.
  - Extracted 5 pure token classification helpers (isEofToken, hasLineBreakBetween, typeTokenText, isLikelyStatementStart, isClassMemberModifier) from parser.ts into `compiler/parser/tokenHelpers.ts` with 18 unit tests. Parser instance-dependent methods remain in parser.ts; further syntax-family separation (JSX, declarations, type annotations) would require structural changes to token consumption flow.
* [x] Reduce the amount of bundling-specific logic living inside generic emission paths.
  - Extracted three pure bundling-stripping helpers (`stripBundledImports`, `stripBundledModuleSyntax`, `stripBundledCommonJsImports`) from `moduleGraph.ts` into `compiler/runtime/bundlingStripping.ts` with 15 unit tests. `moduleGraph.ts` now imports them from the new module.
* [x] Add narrow unit tests for newly extracted helpers before moving larger blocks.
  - `compiler/analysis/typeDisplay.test.ts` and `compiler/analysis/propertyNames.test.ts` cover all extracted functions.
  - `compiler/analysis/controlFlow.test.ts` covers all control-flow predicates.
* [x] Keep behavior-preserving refactors separate from feature work whenever possible.
  - All extraction commits above are pure refactors: same external behavior, tests unchanged, only new test files added.

## Outcome

This task is complete.

What it achieved:

* Reduced responsibility concentration in the highest-risk pure-helper areas of `TypeChecker.ts`, `parser.ts`, and bundling-specific runtime preparation.
* Added narrow, focused tests around each extracted helper family so future refactors can proceed from a safer baseline.
* Kept the changes behavior-preserving and reviewable by avoiding mixed feature/refactor commits.

What remains for future work:

* Stateful `TypeChecker` decomposition into explicit subsystems.
* Parser-family decomposition that also restructures token ownership/consumption.
* Larger emitter/module-graph architectural separation beyond helper extraction.

Those are valid next tasks, but they are no longer open items in this document.
