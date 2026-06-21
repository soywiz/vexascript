# Unify Imported Symbol Resolution Across Types And LSP

## Status

* [ ] Active

## Context

Recent Zod and Pixi regressions keep exposing the same architectural split:

* imported symbol typing can succeed through `importedSymbolTypes`,
* hover can still produce a useful fallback from inferred member types,
* but go to definition can fail because it needs an exact declaration location.

Today those three surfaces do not consume one shared imported-symbol result.
Instead, the compiler often computes:

* a semantic type,
* a display type string,
* a set of external declarations,
* and later a separate navigation result.

That makes it possible for VexaScript to know "what this imported value is"
without knowing "which declaration owns it" in a reusable canonical form.

## Goal

Introduce a shared imported-symbol resolution model that carries semantic and
navigation data together so type analysis, hover, and go to definition stop
drifting apart for the same imported binding.

## Proposed Shape

The exact naming can change, but the model should look roughly like:

```ts
type ResolvedImportedSymbol = {
    localName: string
    exportedName: string
    type: AnalysisType | null
    displayType: string | null
    declarationOrigin: DeclarationOrigin | null
    documentation: string | null
    invalid: boolean
}
```

The important invariant is that imported-symbol resolution should happen once,
and every downstream feature should read from that shared result instead of
reconstructing type-only or declaration-only views independently.

## Scope

* [x] Design one shared imported-symbol resolution record for local modules, ambient modules, and node_modules packages.
* [x] Refactor imported-declaration collection so type info and declaration origin are produced by the same resolution pass where practical.
* [x] Make hover and go to definition consume the shared imported-symbol result before falling back to feature-local heuristics.
* [ ] Reduce cases where `importedSymbolTypes`, `importedSymbolDisplayTypes`, and declaration navigation are populated by separate code paths.
* [ ] Keep the implementation browser-compatible and asynchronous.

## Acceptance Criteria

* [x] Imported bindings that have a resolved type also usually have a reusable declaration origin when the package declarations expose one.
* [x] Zod-style namespace-shaped imports stop relying on one path for type information and another unrelated path for navigation.
* [x] Hover and go to definition for the same imported binding agree on the same resolved declaration origin whenever one exists.
* [ ] Missing declaration locations become explicit in the shared resolution result instead of silently degrading into feature-local behavior.

## Tests

* [x] Add focused regression tests where an imported binding previously had a type but no definition.
* [x] Add coverage proving the same imported binding feeds analysis, hover, and definition consistently.
* [x] Keep `samples/zod/` and `samples/pixi/` passing.
* [x] Run `pnpm test`.
* [x] Run `pnpm cli vexa testFixtures/sample.vx`.

## Progress Notes

The first high-impact slice is now in place:

* `collectAllImportedDeclarations(...)` records `importedSymbolDeclarationOrigins`
  alongside imported types and display types.
* `AnalysisSession` transports that shared map through the LSP session cache.
* `resolveDefinitionAcrossFiles(...)` now consults the shared imported-symbol
  declaration origin before falling back to older per-feature heuristics.

The remaining work is mostly cleanup and further DRY reduction:

* hover should be fed from the same shared imported-symbol record, not only
  from downstream analysis/display fallbacks
* remaining bespoke navigation/type bridges should be collapsed into the same
  resolution model where possible

## Related Files

* `compiler/lsp/importedDeclarations.ts`
* `compiler/lsp/crossFileNavigation.ts`
* `compiler/lsp/crossFileMemberHover.ts`
* `compiler/lsp/nodeModulesTypings.ts`
* `compiler/analysis/TypeChecker.ts`
* `compiler/lsp/lspUnification.test.ts`
