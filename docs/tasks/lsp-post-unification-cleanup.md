# LSP Post-Unification Cleanup

## Status

* [ ] Technical debt
* [~] In progress: ranked in-scope symbol discovery/rendering was extracted from `compiler/lsp/completion.ts` into `compiler/lsp/symbolCompletion.ts`, leaving the orchestrator to compose the strategy modules.

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

* [~] Identify which helpers in `crossFileNavigation.ts` are still feature-specific and move them closer to their feature or into shared context modules.
  - Import-string literal hover/definition now lives in `compiler/lsp/importPathNavigation.ts`, reducing the import-path-specific logic embedded in `crossFileNavigation.ts`.
  - Import-specifier definition resolution now also lives in `compiler/lsp/importPathNavigation.ts`, keeping the import-focused navigation paths grouped together.
* [x] Split `importedDeclarations.ts` into smaller layers such as collection, ambient-module interpretation, and display/shape helpers.
  - Shared ambient-declaration rendering now lives in `compiler/lsp/ambientDisplay.ts`, with direct tests in `compiler/lsp/ambientDisplay.test.ts`.
* [~] Keep `completion.ts` as orchestration only, moving heavier symbol discovery into focused helpers where needed.
  - Ranked visible-symbol completion items now live in `compiler/lsp/symbolCompletion.ts`, with direct helper coverage in `compiler/lsp/completion.test.ts`.
  - Annotation-context detection and declaration-name suppression now live in `compiler/lsp/completionContext.ts`, trimming `completion.ts` toward orchestration-only behavior.
  - Receiver-type recovery and normalization for member completion now live in `compiler/lsp/memberCompletionTypeNames.ts`, reducing non-item-building logic inside `memberCompletion.ts`.
  - Extension-receiver matching and extension return-type inference now live in `compiler/lsp/memberCompletionExtensions.ts`, reducing repeated extension-specific branching inside `memberCompletion.ts`.
  - Textual member-access parsing now lives in `compiler/lsp/memberCompletionParsing.ts`, keeping `memberCompletion.ts` focused more on completion assembly than cursor-string parsing details.
  - Structural object/type-alias member parsing now lives in `compiler/lsp/memberCompletionObjectMembers.ts`, reducing type-shape parsing logic embedded in `memberCompletion.ts`.
  - AST binding/type inference helpers for member completion now live in `compiler/lsp/memberCompletionBindingTypes.ts`, reducing AST-walk-based receiver inference logic embedded in `memberCompletion.ts`.
  - Chained receiver-type resolution for paths like `foo.bar.baz` now lives in `compiler/lsp/memberCompletionPathTypes.ts`, reducing mixed AST/analysis/cross-file lookup logic embedded in `memberCompletion.ts`.
* [~] Audit whether `classResolver.ts` is carrying both resolution and presentation concerns that should be separated.
  - Shared function-signature label formatting now lives in `compiler/lsp/functionTypeDisplay.ts`, reducing the presentation surface owned by `classResolver.ts`.
  - Shared type-name recovery helpers now live in `compiler/lsp/classResolverTypeNames.ts`, keeping `classResolver.ts` more focused on cross-file/member resolution itself.
* [~] Add regression tests that assert the same scenario across multiple LSP features before and after each extraction.
  - `compiler/lsp/lspUnification.test.ts` now asserts that import-path hover and definition agree on the same resolved file, covering the extracted `compiler/lsp/importPathNavigation.ts` path from the unified feature surface.
* [ ] Prefer cleanup work that reduces branching and duplicated lookup paths rather than introducing new abstraction layers for their own sake.
