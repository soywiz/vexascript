# Expand LSP Surface Parity Tests For Imported Symbols

## Status

* [ ] Active

## Context

Several regressions have shared the same shape:

* the imported symbol has a type,
* one LSP surface still works,
* another surface silently falls back or returns `null`.

We already have strong feature-local tests, but we still miss enough
cross-surface parity checks that a regression can pass semantic tests and even
one LSP feature while another feature is broken for the same source location.

## Goal

Build a reusable parity test matrix that exercises the same imported symbol or
member across type analysis, hover, definition, references, rename, semantic
tokens, completion, and diagnostics where relevant.

## Scope

* [ ] Add reusable imported-symbol parity helpers to the LSP test suite.
* [ ] Cover named imports, default imports, namespace imports, and namespace-shaped named exports.
* [ ] Cover local modules, ambient modules, node_modules packages, and export-star barrel chains.
* [ ] Add cases where the imported API is represented by an alias export such as `export { local as publicName }`.
* [ ] Use small synthetic fixtures first, then keep ecosystem samples as broader regression coverage.

## Acceptance Criteria

* [ ] The repo has explicit parity tests that fail when a symbol has a type but hover or definition do not resolve.
* [ ] Zod-style namespace-shaped imports and Pixi-style barrel exports are represented in the parity matrix.
* [ ] New imported-symbol regressions can usually be reproduced in one focused test instead of only through large samples.

## Tests

* [ ] Extend `compiler/lsp/lspUnification.test.ts` with imported-symbol parity scenarios.
* [ ] Add focused node_modules declaration-shape regressions where needed.
* [ ] Keep sample-based regressions in `compiler/lsp/samplesLspSessions.test.ts`.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `compiler/lsp/lspUnification.test.ts`
* `compiler/lsp/crossFileNavigation.test.ts`
* `compiler/lsp/nodeModulesTypings.test.ts`
* `compiler/lsp/samplesLspSessions.test.ts`
* `compiler/test/sourceWithCursor.ts`
