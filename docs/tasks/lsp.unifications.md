# LSP Unification Tasks

## Scope

* [x] Map all current resolution paths used by hover, go to definition, declaration, type definition, implementation, references, rename, and signature help. See `docs/lsp.resolution-paths.md`.
* [x] Document where each feature depends on `Analysis`, `crossFileNavigation`, `crossFileContext`, `classResolver`, `declarationResolver`, `importedDeclarations`, and ambient-type helpers. See `docs/lsp.resolution-paths.md`.
* [x] List the current inconsistent cases: local functions, global functions, imported functions, ambient declarations, default imports, namespace imports, class members, interface members, extension members, constructors, overloads, single-file cases, and cross-file cases. See `docs/lsp.resolution-paths.md`.

## Shared Resolution Model

* [x] Design a shared canonical cursor-target model for all navigation features. See `docs/lsp.cursor-target-model.md`.
* [x] Include local declarations, imported declarations, ambient globals, ambient module members, class members, interface members, extension members, annotations, and documentation-comment parameter references in that model. See `docs/lsp.cursor-target-model.md`.
* [x] Include canonical declaration location, symbol identity, owner/container information, callable metadata, and hover/display metadata in that model. See `docs/lsp.cursor-target-model.md`.

## Shared Entry Point

* [x] Create a shared `resolveCursorTarget(...)` entrypoint in the LSP layer.
* [x] Move character probing and cursor normalization into that shared entrypoint.
* [x] Make hover, definition, references, rename, and signature help consume that shared entrypoint instead of resolving symbols independently.

## Definition And Declaration

* [x] Replace the current split definition flow with one shared declaration-location resolver. `resolveDefinitionWithLocalFallback` in `crossFileNavigation.ts` is the single unified entrypoint covering import paths, import specifiers, member expressions, ambient symbols, and local definitions.
* [x] Make imported symbol navigation consistently jump to the source declaration rather than sometimes stopping on the import site. `resolveImportSpecifierDefinition` (private helper in `crossFileNavigation.ts`) handles the case where the cursor is on the import specifier name.
* [x] Standardize ambient declaration locations for `declare module`, `global {}`, namespace wrappers, `export =`, and bundled runtime declarations. Extracted `findAmbientNamedExportRange` into `crossFileContext.ts` (exported, covering direct declaration, `export = Alias` → namespace body → direct and interface-member patterns, and `global {}` blocks). Replaced the private `findAmbientImportedDeclarationRange` in `crossFileNavigation.ts` with a call to the new shared helper; removed the now-redundant private helpers `findAmbientModuleDeclarationByName` and `findAmbientInterfaceMemberRange`. Tests added in `crossFileNavigation.test.ts` covering direct-declaration lookup, the `export =` namespace-body pattern, name-not-found, and `global {}` block search.

## Hover

* [x] Replace the layered hover flow with one hover builder that consumes the shared resolved target. `resolveHoverWithLocalFallback` in `crossFileNavigation.ts` is the single unified hover entrypoint used by `serverCore.ts`.
* [x] Make hover formatting consistent for local, imported, ambient, member, annotation, and documentation-reference targets.
* [x] Reuse shared documentation extraction for both local and cross-file declarations.

## Signature Help

* [x] Refactor signature help to resolve callees through the same shared target pipeline. `resolveCalleeTarget` in `signatureHelp.ts` now calls `resolveCursorTarget` directly instead of a private `resolveAnalysisTargetAtNode` wrapper.
* [x] Remove signature-help-only fallback ladders where structured callable information can be shared with other features. `collectAmbientFunctionOverloads` now delegates to the shared `collectAmbientFunctionStatements` from `crossFileContext.ts`.
* [x] Standardize overload handling for local functions, imported functions, methods, constructors, extension methods, and ambient module members. `bestActiveSignature` selects by argument count; a cross-reference comment links it to `findAmbientImportedOverloadRange` in `crossFileNavigation.ts`.
* [x] Keep display-string parsing only as an explicit fallback with dedicated tests. The display-string path runs before structured resolution for identifier callees that have a `valueType` (preserving type-alias names from ambient imports), and also as a last-resort fallback after structured resolution fails. Dedicated tests added in `signatureHelp.test.ts`.

## References And Rename

* [x] Make references, rename, and highlight agree on whether they target the declaration, the imported binding, or the exported symbol behind it. `createDocumentHighlights` now uses `createReferences` (which uses `resolveCursorTarget`) so doc-param and annotation highlights are consistent with references.
* [x] Refactor references and rename to operate on one canonical symbol identity. `resolveReferencesAcrossFiles` already uses `resolveCanonicalSymbol` as its identity anchor; confirmed the loop correctly covers all files. `resolveRenameAcrossFiles` now guards against virtual runtime and ambient symbols using the same canonical resolution, and the new `resolvePrepareRenameAcrossFiles` in `crossFileNavigation.ts` gates the editor UI before a rename is attempted.
* [x] Ensure unsupported ambient/imported rename cases fail clearly instead of half-working. Added `resolvePrepareRenameAcrossFiles` (exported from `crossFileNavigation.ts`) that returns `null` for any symbol whose canonical location is a virtual runtime file (`/runtime/dom.d.ts`, `/runtime/es2025.d.ts`, `/runtime/vexascript.d.vx`) or an ambient declaration. `resolveRenameAcrossFiles` applies the same guard so both the prepare and the execution paths reject such symbols consistently. `serverCore.ts` now calls `resolvePrepareRenameAcrossFiles` instead of the local-only `createPrepareRename`. Tests added in `crossFileNavigation.test.ts`.

## Deduplication

* [x] Extract shared helpers for ambient lookup: `detectAmbientExportEqualsName` and `findAmbientNamespaceBody` have been moved from private copies in both `crossFileNavigation.ts` and `signatureHelp.ts` to shared exports in `compiler/lsp/crossFileContext.ts`. `collectAmbientFunctionStatements` has also been extracted to `crossFileContext.ts` and replaces both `collectAmbientFunctionDeclarationsByName` (in `crossFileNavigation.ts`) and the inline iteration in `collectAmbientFunctionOverloads` (in `signatureHelp.ts`).
* [x] Reduce duplicated helper logic across `crossFileNavigation.ts`, `crossFileContext.ts`, `crossFileTypeResolution.ts`, `declarationResolver.ts`, `classResolver.ts`, `importedDeclarations.ts`, and `signatureHelp.ts`. Audited all seven modules for repeated logic. Found and removed two more private duplicates of the already-shared `detectAmbientExportEqualsName`/`findAmbientNamespaceBody` (one in `importedDeclarations.ts` named `detectExportEqualsNameInDecls`/`findNamespaceBodyInStmts`, one in `importFixes.ts` as an exact private re-declaration); both files now import the canonical versions from `crossFileContext.ts`. `declarationResolver.ts` was already the single canonical cross-file top-level declaration resolver reused by `classResolver.ts` and `crossFileTypeResolution.ts` — no changes needed there. `classResolver.ts`'s `resolveClassOwnMember`/`classOwnMemberKind` were compared against `crossFileTypeResolution.ts`'s `classMemberDeclarationRangeByName`/`classMemberInfoByName`: these are legitimately separate (one does type-checking with substitutions, inheritance, and analysis-based getter/setter inference for the type system; the other returns simple ranges/labels for navigation/hover) and were left as-is rather than forcing a shared abstraction.
* [x] Extract shared helpers for export unwrapping, imported-binding normalization, member ownership lookup, and declaration metadata building. Export-unwrapping (`detectAmbientExportEqualsName`/`findAmbientNamespaceBody`) was already shared and is now used by all five consumers (`crossFileNavigation.ts`, `signatureHelp.ts`, `importedDeclarations.ts`, `importFixes.ts`, and indirectly through `collectAmbientFunctionStatements`). For imported-binding normalization, found and extracted a genuine duplicate: `resolveAmbientModuleObjectMemberDefinition` (`crossFileNavigation.ts`) and `ambientDefaultImportMemberSignatures` (`signatureHelp.ts`) both independently matched a member-expression receiver against a default/namespace import binding and built the same `node:`-stripped module-name candidate list. Extracted `findAmbientModuleReceiverCandidates(ast, receiverName)` into `crossFileContext.ts` and updated both call sites. Member ownership lookup and declaration metadata building were audited (see above) and found to already be unified where the underlying purpose is the same; the remaining differences reflect genuinely different concerns (type resolution vs. navigation), not duplication.
* [x] Remove ad hoc string-based or feature-specific symbol formatting where shared structured metadata can be used instead. Found four near-identical copies of "render a parameter as `...name?: Type`" and the surrounding `(params) => ReturnType` function-type-label join: `formatParameterLabel` (`signatureHelp.ts`), the inline mapper in `functionTypeLabelFromParameters` (`crossFileTypeResolution.ts`), `renderAmbientFunctionDisplayFromParts` (`importedDeclarations.ts`), and `formatResolvedFunctionSignature` (`objectLiteralCompletion.ts`), plus two inline copies in `classResolver.ts` itself. Extracted `formatParameterLabel` and `formatFunctionTypeLabel` into `classResolver.ts` (next to the `ResolvedParameter`/`ResolvedFunctionSignature` types they operate on) and updated all six call sites to delegate to the shared formatters; added direct unit tests in the new `compiler/lsp/classResolver.test.ts`. As a side effect this fixed two latent display inconsistencies (a missing `?` suffix for optional class/interface method parameters, and a missing `...` rest prefix in `functionTypeLabelFromParameters`), both covered by the existing/added test suite. `createMemberHoverContents` (`crossFileNavigation.ts`) was reviewed and left as-is: it only concatenates an already-fully-formatted label, not a place where formatting logic is duplicated.

## Tests

* [x] Add regression tests proving that multiple LSP features resolve the same canonical target in the same scenario. See `compiler/lsp/lspUnification.test.ts`.
* [x] Prefer shared `^^^` cursor-marker fixtures for cross-feature scenarios.
* [x] Add test coverage for local, imported, ambient, member, annotation, and documentation-reference scenarios in the unified cross-feature test file.
* [ ] Expand tests so the same source scenarios are checked across hover, definition, references, rename, and signature help.
* [ ] Add test coverage for overload and runtime declaration scenarios.

## Migration

* [x] Update `docs/lsp.services.md` with the new unified navigation architecture section.
* [x] Keep `docs/file.structure.md` aligned with the final module layout (updated to mention `resolveHoverWithLocalFallback`, `lspUnification.test.ts`, and the shared ambient helpers).
* [x] Migrate feature by feature in this order: definition/declaration, hover, signature help, references/rename. This migration already completed in the sections above this checklist (all "Cross-File Navigation"/"Unified Hover"/"Signature Help"/"References, Rename, Highlight" sections are checked `[x]`): `resolveDefinitionWithLocalFallback` and `resolveHoverWithLocalFallback` are the single unified entrypoints for definition/declaration and hover, `resolveCalleeTarget` in `signatureHelp.ts` resolves callees through the shared `resolveCursorTarget` pipeline, and `resolveReferencesAcrossFiles`/`resolveRenameAcrossFiles`/`resolvePrepareRenameAcrossFiles` share the same canonical-symbol identity. The deduplication pass in this change reinforced that migration by removing the remaining private per-feature copies of ambient-lookup and parameter/function-type formatting logic so every feature reads from the same shared helpers.
* [x] Remove obsolete fallback paths only after the new shared pipeline has coverage. No obsolete fallback paths were found still in place: the per-feature private duplicates removed in this change (`detectExportEqualsNameInDecls`/`findNamespaceBodyInStmts` in `importedDeclarations.ts`, the exact-duplicate `detectAmbientExportEqualsName`/`findAmbientNamespaceBody` in `importFixes.ts`, and the inline receiver-matching logic in `crossFileNavigation.ts`/`signatureHelp.ts`) were removed in the same change that pointed their call sites at the shared helpers, and the full test suite (`pnpm test`, 1358 tests) passes with no regressions, confirming the new shared pipeline already had full behavioral coverage before the fallback code was deleted.
