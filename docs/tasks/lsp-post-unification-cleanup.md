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
  - Ambient imported-symbol and ambient module object-member definition lookup now lives in `compiler/lsp/crossFileAmbientNavigation.ts`, reducing ambient-module-specific branching embedded in `crossFileNavigation.ts`.
  - Member hover resolution now lives in `compiler/lsp/crossFileMemberHover.ts`, reducing hover-specific type/member formatting and lookup branching embedded in `crossFileNavigation.ts`.
  - Implicit-receiver definition lookup for bare member calls inside receiver extensions now lives in `compiler/lsp/crossFileImplicitReceiver.ts`, reducing implicit-receiver-specific control flow embedded in `crossFileNavigation.ts`.
  - Extension-member and node_modules member-definition source lookup now lives in `compiler/lsp/crossFileMemberDefinitionSources.ts`, reducing source-specific fallback branching embedded in `crossFileNavigation.ts`.
  - Class/interface/type-alias/structural declared-member definition lookup now lives in `compiler/lsp/crossFileDeclaredMemberDefinition.ts`, reducing declaration-resolution-specific branching embedded in `crossFileNavigation.ts`.
  - Cross-file member/symbol reference lookup now lives in `compiler/lsp/crossFileReferences.ts`, reducing reference-collection/index-scanning branching embedded in `crossFileNavigation.ts`.
  - Cross-file rename guards and workspace-edit assembly now live in `compiler/lsp/crossFileRename.ts`, reducing runtime/ambient rename-policy branching embedded in `crossFileNavigation.ts`.
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
  - Namespace lookup and namespace-member completion now live in `compiler/lsp/memberCompletionNamespaces.ts`, reducing namespace-specific branching embedded in `memberCompletion.ts`.
  - Extension-member collection, imported-extension lookup, and extension auto-import completion assembly now live in `compiler/lsp/memberCompletionExtensionMembers.ts`, reducing extension-specific completion assembly embedded in `memberCompletion.ts`.
  - Ambient-interface member collection plus member-access recovery source rewriting/retry logic now live in `compiler/lsp/memberCompletionRecovery.ts`, reducing recovery-specific control flow embedded in `memberCompletion.ts`.
  - Class/interface/enum completion-item builders now live in `compiler/lsp/memberCompletionItemBuilders.ts`, reducing item-rendering and operator-edit assembly logic embedded in `memberCompletion.ts`.
  - Interface/enum/type-alias/object-shape member resolution for the non-class branch of member completion now lives in `compiler/lsp/memberCompletionTypeMembers.ts`, reducing mixed declaration lookup logic embedded in `buildMemberCompletionItemsForType`.
  - Parsed object-path member-access resolution for enum suppression, namespace lookup, and receiver-type lookup now lives in `compiler/lsp/memberCompletionTargetPaths.ts`, keeping `memberCompletion.ts` more focused on high-level orchestration and analyzed-expression fallback.
  - Analysis-driven fallback completion for complex receivers like calls and chained expressions now lives in `compiler/lsp/memberCompletionAnalyzedReceiver.ts`, reducing analysis-specific receiver lookup embedded in `memberCompletion.ts`.
* [~] Audit whether `classResolver.ts` is carrying both resolution and presentation concerns that should be separated.
  - Shared function-signature label formatting now lives in `compiler/lsp/functionTypeDisplay.ts`, reducing the presentation surface owned by `classResolver.ts`.
  - Shared type-name recovery helpers now live in `compiler/lsp/classResolverTypeNames.ts`, keeping `classResolver.ts` more focused on cross-file/member resolution itself.
  - Class/interface member and signature-shape builders now live in `compiler/lsp/classResolverMemberShapes.ts`, reducing result-shape/documentation formatting branching embedded in `classResolver.ts`.
* [~] Add regression tests that assert the same scenario across multiple LSP features before and after each extraction.
  - `compiler/lsp/lspUnification.test.ts` now asserts that import-path hover and definition agree on the same resolved file, covering the extracted `compiler/lsp/importPathNavigation.ts` path from the unified feature surface.
* [ ] Prefer cleanup work that reduces branching and duplicated lookup paths rather than introducing new abstraction layers for their own sake.
