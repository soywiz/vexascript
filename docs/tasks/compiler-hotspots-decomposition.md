# Compiler Hotspots Decomposition

## Status

* [ ] Technical debt

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

* [ ] Map the internal responsibility slices inside `TypeChecker.ts` and extract the easiest read-only helpers first.
* [ ] Separate statement-family checking from shared type/call resolution helpers.
* [ ] Split parser logic by syntax families where it reduces branching without duplicating token flow.
* [ ] Reduce the amount of bundling-specific logic living inside generic emission paths.
* [ ] Add narrow unit tests for newly extracted helpers before moving larger blocks.
* [ ] Keep behavior-preserving refactors separate from feature work whenever possible.
