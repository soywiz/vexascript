# LSP Unification Tasks

## Scope

* [x] Map all current resolution paths used by hover, go to definition, declaration, type definition, implementation, references, rename, and signature help. See `docs/lsp.resolution-paths.md`.
* [x] Document where each feature depends on `Analysis`, `crossFileNavigation`, `crossFileContext`, `classResolver`, `declarationResolver`, `importedDeclarations`, and ambient-type helpers. See `docs/lsp.resolution-paths.md`.
* [ ] List the current inconsistent cases: local functions, global functions, imported functions, ambient declarations, default imports, namespace imports, class members, interface members, extension members, constructors, overloads, single-file cases, and cross-file cases.

## Shared Resolution Model

* [ ] Design a shared canonical cursor-target model for all navigation features.
* [ ] Include local declarations, imported declarations, ambient globals, ambient module members, class members, interface members, extension members, annotations, and documentation-comment parameter references in that model.
* [ ] Include canonical declaration location, symbol identity, owner/container information, callable metadata, and hover/display metadata in that model.

## Shared Entry Point

* [ ] Create a shared `resolveCursorTarget(...)` entrypoint in the LSP layer.
* [ ] Move character probing and cursor normalization into that shared entrypoint.
* [ ] Make hover, definition, references, rename, and signature help consume that shared entrypoint instead of resolving symbols independently.

## Definition And Declaration

* [ ] Replace the current split definition flow with one shared declaration-location resolver.
* [ ] Make imported symbol navigation consistently jump to the source declaration rather than sometimes stopping on the import site.
* [ ] Standardize ambient declaration locations for `declare module`, `global {}`, namespace wrappers, `export =`, and bundled runtime declarations.

## Hover

* [ ] Replace the layered hover flow with one hover builder that consumes the shared resolved target.
* [ ] Make hover formatting consistent for local, imported, ambient, member, annotation, and documentation-reference targets.
* [ ] Reuse shared documentation extraction for both local and cross-file declarations.

## Signature Help

* [ ] Refactor signature help to resolve callees through the same shared target pipeline.
* [ ] Remove signature-help-only fallback ladders where structured callable information can be shared with other features.
* [ ] Standardize overload handling for local functions, imported functions, methods, constructors, extension methods, and ambient module members.
* [ ] Keep display-string parsing only as an explicit fallback with dedicated tests.

## References And Rename

* [ ] Refactor references and rename to operate on one canonical symbol identity.
* [ ] Make references, rename, and highlight agree on whether they target the declaration, the imported binding, or the exported symbol behind it.
* [ ] Ensure unsupported ambient/imported rename cases fail clearly instead of half-working.

## Deduplication

* [ ] Reduce duplicated helper logic across `crossFileNavigation.ts`, `crossFileContext.ts`, `crossFileTypeResolution.ts`, `declarationResolver.ts`, `classResolver.ts`, `importedDeclarations.ts`, and `signatureHelp.ts`.
* [ ] Extract shared helpers for export unwrapping, ambient lookup, imported-binding normalization, member ownership lookup, and declaration metadata building.
* [ ] Remove ad hoc string-based or feature-specific symbol formatting where shared structured metadata can be used instead.

## Tests

* [ ] Expand tests so the same source scenarios are checked across hover, definition, references, rename, and signature help.
* [ ] Add test coverage for local, imported, ambient, member, overload, runtime declaration, annotation, and documentation-reference scenarios.
* [ ] Add regression tests proving that multiple LSP features resolve the same canonical target in the same scenario.
* [ ] Prefer shared `^^^` cursor-marker fixtures for cross-feature scenarios.

## Migration

* [ ] Migrate feature by feature in this order: definition/declaration, hover, signature help, references/rename.
* [ ] Remove obsolete fallback paths only after the new shared pipeline has coverage.
* [ ] Update `docs/lsp.services.md` after the new architecture is in place.
* [ ] Keep `docs/file.structure.md` aligned with the final module layout.
