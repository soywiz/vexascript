# LSP Post-Unification Cleanup

## Status

* [ ] Technical debt

## Context

The LSP layer has improved a lot and the unification work is mostly complete. That is a good state to be in. The remaining debt is that some of the implementation still lives in large service files with mixed responsibilities:

* `compiler/lsp/crossFileNavigation.ts`
* `compiler/lsp/importedDeclarations.ts`
* `compiler/lsp/classResolver.ts`
* `compiler/lsp/memberCompletion.ts`
* `compiler/lsp/completion.ts`

The main LSP unification work is already complete; this task is about the cleanup pass after that success, not about redoing the unification.

## Why This Is Debt

The current LSP layer works, but some concerns are still too close together:

* navigation, hover, references, rename, and signature-related helpers still share large utility surfaces
* ambient/imported declaration handling remains powerful but dense
* completion still spans orchestration plus several heavy resolution paths
* display/label formatting and symbol-shape inference are improved, but still spread across a few large modules

This makes future LSP features slower to add and increases the chance of reintroducing path-specific fixes.

## Desired End State

Keep the unified behavior, but make the implementation easier to reason about:

* one clear canonical resolution surface
* thinner feature entrypoints
* smaller ambient/imported-declaration helpers
* narrower completion sub-pipelines
* shared formatting/display utilities used consistently

## Suggested Tasks

* [ ] Identify which helpers in `crossFileNavigation.ts` are still feature-specific and move them closer to their feature or into shared context modules.
* [ ] Split `importedDeclarations.ts` into smaller layers such as collection, ambient-module interpretation, and display/shape helpers.
* [ ] Keep `completion.ts` as orchestration only, moving heavier symbol discovery into focused helpers where needed.
* [ ] Audit whether `classResolver.ts` is carrying both resolution and presentation concerns that should be separated.
* [ ] Add regression tests that assert the same scenario across multiple LSP features before and after each extraction.
* [ ] Prefer cleanup work that reduces branching and duplicated lookup paths rather than introducing new abstraction layers for their own sake.
