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
* [ ] Standardize ambient declaration locations for `declare module`, `global {}`, namespace wrappers, `export =`, and bundled runtime declarations.

## Hover

* [x] Replace the layered hover flow with one hover builder that consumes the shared resolved target. `resolveHoverWithLocalFallback` in `crossFileNavigation.ts` is the single unified hover entrypoint used by `serverCore.ts`.
* [ ] Make hover formatting consistent for local, imported, ambient, member, annotation, and documentation-reference targets.
* [ ] Reuse shared documentation extraction for both local and cross-file declarations.

## Signature Help

* [ ] Refactor signature help to resolve callees through the same shared target pipeline.
* [ ] Remove signature-help-only fallback ladders where structured callable information can be shared with other features.
* [ ] Standardize overload handling for local functions, imported functions, methods, constructors, extension methods, and ambient module members.
* [ ] Keep display-string parsing only as an explicit fallback with dedicated tests.

## References And Rename

* [x] Make references, rename, and highlight agree on whether they target the declaration, the imported binding, or the exported symbol behind it. `createDocumentHighlights` now uses `createReferences` (which uses `resolveCursorTarget`) so doc-param and annotation highlights are consistent with references.
* [ ] Refactor references and rename to operate on one canonical symbol identity.
* [ ] Ensure unsupported ambient/imported rename cases fail clearly instead of half-working.

## Deduplication

* [x] Extract shared helpers for ambient lookup: `detectAmbientExportEqualsName` and `findAmbientNamespaceBody` have been moved from private copies in both `crossFileNavigation.ts` and `signatureHelp.ts` to shared exports in `compiler/lsp/crossFileContext.ts`.
* [ ] Reduce duplicated helper logic across `crossFileNavigation.ts`, `crossFileContext.ts`, `crossFileTypeResolution.ts`, `declarationResolver.ts`, `classResolver.ts`, `importedDeclarations.ts`, and `signatureHelp.ts`.
* [ ] Extract shared helpers for export unwrapping, imported-binding normalization, member ownership lookup, and declaration metadata building.
* [ ] Remove ad hoc string-based or feature-specific symbol formatting where shared structured metadata can be used instead.

## Tests

* [x] Add regression tests proving that multiple LSP features resolve the same canonical target in the same scenario. See `compiler/lsp/lspUnification.test.ts`.
* [x] Prefer shared `^^^` cursor-marker fixtures for cross-feature scenarios.
* [x] Add test coverage for local, imported, ambient, member, annotation, and documentation-reference scenarios in the unified cross-feature test file.
* [ ] Expand tests so the same source scenarios are checked across hover, definition, references, rename, and signature help.
* [ ] Add test coverage for overload and runtime declaration scenarios.

## Migration

* [x] Update `docs/lsp.services.md` with the new unified navigation architecture section.
* [x] Keep `docs/file.structure.md` aligned with the final module layout (updated to mention `resolveHoverWithLocalFallback`, `lspUnification.test.ts`, and the shared ambient helpers).
* [ ] Migrate feature by feature in this order: definition/declaration, hover, signature help, references/rename.
* [ ] Remove obsolete fallback paths only after the new shared pipeline has coverage.
