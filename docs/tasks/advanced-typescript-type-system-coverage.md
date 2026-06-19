# Expand Advanced TypeScript Type-System Coverage

## Status

* [ ] Active

## Context

The parser already preserves several advanced TypeScript type-system constructs structurally, but semantic resolution still handles only a narrow subset of them.

Today this is most visible in:

* mapped types beyond simple property filtering,
* conditional types beyond a few special cases,
* `infer`-based extraction patterns,
* template literal types,
* and advanced `keyof` or indexed-access combinations.

The result is that complex declaration graphs from real packages often lose precision long before assignability runs, because the checker never reconstructs the intended type shape.

## Goal

Broaden semantic support for advanced TypeScript type constructs so VexaScript can preserve and reason about modern `.d.ts` type expressions instead of collapsing them into `unknown` or over-simplified object shapes.

## Scope

* [ ] Expand mapped-type support beyond the current simple object-property transform subset.
* [ ] Support richer `[K in ...]` patterns, including better key-source resolution.
* [ ] Add support for mapped-type modifier behavior where practical, including optional and readonly-related semantics.
* [ ] Support key remapping patterns such as `[K in keyof T as ...]`.
* [ ] Expand conditional-type resolution beyond the current narrow branch-selection cases.
* [ ] Support distributive conditional behavior over unions where feasible.
* [ ] Add semantic support for `infer` in conditional types for common extraction patterns.
* [ ] Add semantic support for template literal types.
* [ ] Tighten `keyof` and indexed-access behavior for imported and aliased advanced types.
* [ ] Keep the implementation conservative where necessary, but prefer partial structural resolution over immediate fallback to `unknown`.
* [ ] Update `docs/syntax.md` to reflect the precise supported subset once expanded.

## Acceptance Criteria

* [ ] Common advanced type aliases from modern `.d.ts` files resolve to meaningful shapes instead of collapsing to `unknown`.
* [ ] `infer`-based extraction patterns used by ecosystem packages have regression coverage.
* [ ] Template literal types have explicit semantic behavior and tests.
* [ ] Mapped and conditional types behave consistently between local code and imported declaration files.
* [ ] Documentation no longer describes these features only as parser-preserved when semantic support has been added.

## Tests

* [ ] Add focused semantic tests for mapped types.
* [ ] Add focused semantic tests for conditional types and distributive behavior.
* [ ] Add focused semantic tests for `infer` patterns.
* [ ] Add focused semantic tests for template literal types.
* [ ] Add imported-declaration regression coverage using realistic `.d.ts` fixtures.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `compiler/analysis/TypeChecker.ts`
* `compiler/analysis/typeNames.ts`
* `compiler/analysis/types.ts`
* `compiler/lsp/importedDeclarations.ts`
* `compiler/lsp/nodeModulesTypings.test.ts`
* `docs/syntax.md`
