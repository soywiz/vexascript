# Improve Imported Type Assignability For Ecosystem Libraries

## Status

* [ ] Active

## Context

Recent ecosystem samples exposed a practical gap that is now more important than any one missing syntax feature: VexaScript still rejects object literals and option bags that ordinary TypeScript accepts against large imported declaration types.

Current failures already show up in the sample suite:

* Pixi option objects such as text-style configuration are rejected against imported parameter types.
* Three.js material parameter objects are rejected against imported declaration types.
* React ecosystem libraries such as React Query stress the same area with generic-heavy options objects and result types.

These failures usually mean one or more of the following:

* imported declaration types are not being normalized deeply enough,
* advanced utility, mapped, or conditional aliases are only partially resolved before assignability runs,
* property optionality and readonly semantics are not preserved accurately enough,
* or object-literal assignability is stricter than it should be once real `.d.ts` shapes are involved.

## Goal

Make assignability against imported package typings behave much closer to TypeScript for real-world library option objects, hook options, config shapes, and parameter bags.

## Scope

* [ ] Reproduce and classify the current assignability failures in `samples/pixi/` and `samples/threejs/`.
* [ ] Add a React Query-focused regression that exercises imported generic options and result types without fallback casts.
* [ ] Identify where imported type resolution loses structure before assignability.
* [ ] Tighten object-literal assignability against imported interface, alias, and intersection-heavy shapes.
* [ ] Preserve optional-property behavior accurately enough that partial config objects do not get rejected spuriously.
* [ ] Revisit readonly and array-like compatibility where imported APIs expect readonly collections.
* [ ] Reduce cases where imported parameter or result types surface as `unknown` after successful symbol resolution.
* [ ] Use ecosystem samples as regression drivers rather than one-off fixes.
* [ ] Update `docs/tasks/ecosystem-stress-samples.md` if new sample-specific follow-ups are discovered.

## Acceptance Criteria

* [ ] `samples/pixi.test.ts` passes without sample-local casts or workaround typings for the covered option objects.
* [ ] `samples/threejs.test.ts` passes without sample-local casts or workaround typings for the covered parameter objects.
* [ ] A React Query-oriented regression proves imported hook option and result types remain structurally useful in VexaScript.
* [ ] Imported object-literal assignability failures are explained by real incompatibilities, not type-resolution collapse.
* [ ] Hover, diagnostics, and assignability all reflect the same imported structural type instead of mixing resolved and `unknown` views.

## Tests

* [ ] Keep `samples/pixi.test.ts` passing.
* [ ] Keep `samples/threejs.test.ts` passing.
* [ ] Add targeted imported-typing regression tests for the failing shapes behind those samples.
* [ ] Add React Query regression coverage for imported options and result typing.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `samples/pixi/`
* `samples/threejs/`
* `samples/react/`
* `samples/samples.test.ts`
* `compiler/analysis/TypeChecker.ts`
* `compiler/lsp/importedDeclarations.ts`
* `compiler/lsp/nodeModulesTypings.ts`
* `compiler/lsp/nodeModulesTypings.test.ts`
* `docs/tasks/ecosystem-stress-samples.md`
