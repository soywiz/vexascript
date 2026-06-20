# Improve Higher-Order Generic And Variadic Inference

## Status

* [ ] Active

## Context

Several ecosystem libraries that still fail in VexaScript are not blocked by one missing syntax form. They are blocked by generic information decaying across higher-order calls, currying layers, overload sets, and variadic tuple-like signatures.

This shows up especially in:

* curried state factories such as `zustand`,
* observable/operator APIs such as `rxjs`,
* and heavily callback-driven helpers whose type precision depends on inference flowing across multiple call boundaries.

VexaScript already supports many direct generic calls, contextual function typing, and some imported utility aliases, but the remaining failures suggest the inference model still becomes too shallow once the API is higher-order and variadic at the same time.

## Goal

Preserve useful generic specifics across higher-order imported APIs so more real TS-first libraries keep their public types instead of collapsing to `unknown` or unspecialized shapes.

## Scope

* [ ] Improve generic inference across curried call chains.
* [ ] Preserve imported overload information more faithfully for higher-order methods and functions.
* [ ] Improve callback-parameter and callback-return inference when the surrounding API is imported and generic-heavy.
* [ ] Support more variadic tuple and rest-parameter inference patterns used in public package typings.
* [ ] Keep partially recoverable higher-order APIs structural rather than immediately widening to `unknown`.
* [ ] Add realistic regressions derived from current `rxjs` and `zustand` failures before changing implementation.

## Acceptance Criteria

* [ ] A focused `rxjs` regression keeps observable members and chained higher-order calls structurally typed farther than today.
* [ ] A focused `zustand` regression keeps curried store factories and `getState()` result typing structurally useful farther than today.
* [ ] Imported higher-order APIs no longer lose type precision merely because the generic flow spans more than one call.

## Tests

* [ ] Add targeted semantic regressions for curried generic factories.
* [ ] Add targeted imported-typing regressions for variadic and overloaded higher-order APIs.
* [ ] Update `docs/tasks/ecosystem-stress-samples.md` when `rxjs` or `zustand` sample status changes.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `compiler/analysis/TypeChecker.ts`
* `compiler/analysis/Analysis.generics.test.ts`
* `compiler/lsp/importedDeclarations.ts`
* `compiler/lsp/nodeModulesTypings.test.ts`
* `docs/tasks/ecosystem-stress-samples.md`
