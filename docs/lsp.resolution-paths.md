# LSP Resolution Paths

This document maps the resolution paths that existed before the shared cursor-target model work. It remains the historical baseline for the completed LSP unification effort recorded in `docs/tasks/completed/lsp.unifications.md` and for later cleanup work.

## Request dispatch

`compiler/lsp/serverCore.ts` is the request fan-out point. It builds a per-document analysis session, constructs the cross-file feature context, and then calls feature-specific helpers.

| LSP feature | Server entry point | Primary resolver path | Local fallback path |
| --- | --- | --- | --- |
| Hover | `connection.onHover` | `resolveImportPathHover(...)`, then `resolveMemberHoverAcrossFiles(...)` for normalized cursor candidates | `createHover(...)` for documentation parameter refs, annotation refs, then `Analysis.getHoverAt(...)` |
| Definition | `connection.onDefinition` | `resolveDefinitionWithLocalFallback(...)` -> `resolveDefinitionAcrossFiles(...)` | `createDefinitionLocation(...)` |
| Declaration | `connection.onDeclaration` | Same as definition | Same as definition |
| Type definition | `connection.onTypeDefinition` | Same as definition | Same as definition |
| Implementation | `connection.onImplementation` | Same as definition | Same as definition |
| References | `connection.onReferences` | `resolveReferencesAcrossFiles(...)` | `localReferencesFromContext(...)` / `Analysis.getReferenceRangesAt(...)` |
| Rename | `connection.onRenameRequest` | `resolveRenameAcrossFiles(...)` over cross-file references | `localRenameWorkspaceEdit(...)` / `createRenameWorkspaceEdit(...)` semantics |
| Prepare rename | `connection.onPrepareRename` | No cross-file resolver | `createPrepareRename(...)` |
| Signature help | `connection.onSignatureHelp` | `createSignatureHelp(...)` with `ClassResolverOptions` and ambient module declarations | Signature-help-specific symbol/type/display fallbacks |
| Document highlight | `connection.onDocumentHighlight` | No cross-file resolver | `createDocumentHighlights(...)` -> `Analysis.getReferenceRangesAt(...)` |

## Definition, declaration, type definition, and implementation

The four navigation requests currently share one server handler. The handler calls `resolveDefinitionWithLocalFallback(...)`, which intentionally prefers cross-file resolution so imported symbols jump to their source declarations instead of the import specifier.

`resolveDefinitionAcrossFiles(...)` tries these cases in order:

1. Import string literals and import paths via `resolveImportPathDefinition(...)`.
2. Explicit member expressions through `resolveMemberDefinitionAcrossFiles(...)`.
3. Implicit receiver member references through `resolveImplicitReceiverMemberDefinition(...)`.
4. Type identifiers via `findTypeIdentifierAtPosition(...)` and `resolveTypeDefinitionAcrossFiles(...)`.
5. Ambient imported symbols via `resolveAmbientImportedSymbolDefinition(...)`.
6. Canonical top-level symbols via `resolveCanonicalSymbol(...)`.

If all cross-file branches miss, `createDefinitionLocation(...)` handles local-only cases in this order:

1. Documentation-comment parameter references through `findDocumentationParameterReference(...)`.
2. Annotation applications through `annotationReferenceAt(...)`.
3. Semantic local definitions through `Analysis.getDefinitionAt(...)`.

## Hover

Hover still has a layered server-side flow instead of one canonical target. The server checks import-path hover first, then tries `resolveMemberHoverAcrossFiles(...)` for candidate cursor characters produced by `candidateCharacters(...)`, then falls back to `createHover(...)` for each candidate.

The local hover path checks documentation parameter references, annotation references, and finally `Analysis.getHoverAt(...)`. Cross-file member hover has its own member lookup and type formatting path in `crossFileNavigation.ts`, including class/interface members, structural object members, and type-alias member fallbacks.

## References, rename, and highlights

References use `resolveReferencesAcrossFiles(...)` first. Member references are resolved by `resolveMemberReferencesAcrossFiles(...)`; otherwise the resolver collects the local fallback references, resolves a canonical symbol with `resolveCanonicalSymbol(...)`, scans source roots with the project index, and merges references from the defining file and importer files. The same reference set drives `resolveRenameAcrossFiles(...)`.

Local references and prepare-rename include special documentation parameter-reference handling in `navigation.ts`, but document highlights bypass that helper and call `Analysis.getReferenceRangesAt(...)` directly. This means references, rename, and highlight can disagree for documentation-comment parameter references until they share a canonical symbol identity.

## Signature help

Signature help is independent from definition/hover/reference resolution. `createSignatureHelp(...)` first detects annotation invocation syntax, then regular call/new-expression invocation syntax. Callable resolution proceeds through signature-help-specific helpers:

1. Direct semantic symbol/type information from `Analysis.getSymbolAt(...)` and function types.
2. Class/interface/method and constructor helpers from `classResolver.ts` through `resolveCallableSignatures(...)` and `resolveConstructorSignature(...)`.
3. Ambient default-import member overload handling from ambient module declarations.
4. Display-string parsing through `signatureInfosFromDisplayFunctionType(...)` as an explicit fallback.

This gives signature help good coverage for functions, methods, constructors, overloads, annotations, and ambient module members, but the callee resolution path is not shared with go-to-definition or hover.

## Shared dependency map

| Dependency | Current role in resolution paths |
| --- | --- |
| `Analysis` | Single-file symbol, hover, definition, reference, prepare-rename, highlight, and signature type queries. |
| `crossFileNavigation.ts` | Cross-file orchestration for definition, hover, references, rename, imports, ambient imports, and member-specific navigation. |
| `crossFileContext.ts` | Resolve context, effective source roots, session lookup, canonical symbol lookup, import matching, ambient declaration locations, local reference/rename fallbacks, and range utilities. |
| `crossFileTypeResolution.ts` | Type/member shape lookup, class/interface/type-alias/member declaration resolution, type-definition resolution, and canonical member symbols. |
| `classResolver.ts` | Class/interface member resolution, callable signature extraction, constructor signatures, and resolver caching. |
| `declarationResolver.ts` | Top-level declaration lookup across files and declaration-name extraction. |
| `importedDeclarations.ts` | Imported type/function declaration collection for external analysis and function type construction. |
| Ambient-type helpers | Runtime declarations, DOM declarations, `ambientTypesLoader.ts`, node module typings, ambient module declaration maps, and ambient declaration source-location mapping. |

## Feature dependency inventory

This inventory records where each user-facing LSP feature depends on the major resolver building blocks today, so later migration steps can replace feature-specific paths with a shared cursor-target entry point without losing coverage.

| Feature | `Analysis` dependency | Cross-file dependency | Declaration/type dependency | Import/ambient dependency |
| --- | --- | --- | --- | --- |
| Hover | `createHover(...)` handles documentation parameter references, annotation references, and `Analysis.getHoverAt(...)` for local symbols. | `crossFileNavigation.ts` handles import-path hover and member hover before local fallback. `crossFileContext.ts` supplies source roots, candidate ranges, and sessions for opened/project files. | Cross-file member hover uses `crossFileTypeResolution.ts` plus `classResolver.ts`-style member shape information for class, interface, structural, and type-alias members. | Imported and ambient declarations flow through the session built from `importedDeclarations.ts`, runtime/DOM declarations, and `ambientTypesLoader.ts` maps. |
| Definition, declaration, type definition, implementation | Local fallback uses documentation parameter references, annotation references, and `Analysis.getDefinitionAt(...)`. | `crossFileNavigation.ts` owns the preferred cross-file path through `resolveDefinitionWithLocalFallback(...)`; `crossFileContext.ts` resolves canonical symbols, importer matches, ambient locations, and LSP ranges. | `declarationResolver.ts` finds top-level source declarations. `crossFileTypeResolution.ts` resolves type identifiers, member declarations, and canonical member symbols. `classResolver.ts` informs member and constructor targets indirectly through shared class/interface shape lookup. | `importedDeclarations.ts` enriches analysis with imported declaration/type data, while ambient helpers provide module/global declarations and source locations for `declare module`, DOM, runtime, and package typings. |
| References | `localReferencesFromContext(...)` and local fallback ranges ultimately rely on `Analysis.getReferenceRangesAt(...)`. | `crossFileNavigation.ts` scans defining and importer files after `crossFileContext.ts` builds the canonical symbol context and source-root sessions. | `declarationResolver.ts` and `crossFileTypeResolution.ts` determine whether the target is a top-level symbol or member symbol before scanning references. | Ambient/imported references depend on import matching and imported declaration metadata; unsupported ambient rename/reference shapes remain constrained by the ambient source-location maps. |
| Rename and prepare rename | Prepare rename is local-only through `createPrepareRename(...)`; local edits use `Analysis` reference ranges and the local rename helper. | Rename uses `resolveRenameAcrossFiles(...)` over the cross-file reference set from `crossFileNavigation.ts`; `crossFileContext.ts` creates workspace edits and local fallbacks. | Top-level and member ownership come from the same declaration and type-resolution helpers used by references. | Imported bindings are normalized through cross-file import matching; ambient/imported rename cases that cannot produce safe workspace edits are intentionally rejected or left to local fallback. |
| Signature help | `createSignatureHelp(...)` uses `Analysis.getSymbolAt(...)`, semantic function types, active argument detection, and display-string fallbacks. | Signature help does not use `crossFileNavigation.ts` or `crossFileContext.ts` as a resolver pipeline today. | `classResolver.ts` directly provides callable signatures and constructor signatures for methods, constructors, interfaces, and classes. | Ambient module overloads and default-import member calls are resolved from the session's ambient module declarations and imported symbol types built by `importedDeclarations.ts` and ambient-type loading. |
| Document highlight | `createDocumentHighlights(...)` calls `Analysis.getReferenceRangesAt(...)` directly. | No cross-file resolver is used. | No declaration/type resolver is used beyond the local analysis result. | Ambient/imported shapes are only represented if the local `Analysis` reference data already exposes them. |

## Known inconsistent cases to preserve as migration tests

The unification work should add cross-feature tests for each of these before deleting old fallbacks. The cases below are intentionally phrased as observable behavior differences rather than design goals, so they can seed migration regression tests.

| Case | Current inconsistency | Migration test expectation |
| --- | --- | --- |
| Local functions | Definition, hover, references, rename, and highlights mostly come from local `Analysis`, while signature help re-resolves the callee through function-type extraction and display-string fallback code. | Every feature should resolve the same local declaration identity before building feature-specific output. |
| Global functions | Top-level declarations in the active file use local `Analysis`; cross-file references and definition promote them through `resolveCanonicalSymbol(...)`; signature help stays on its independent callable path. | A file-local use and a cross-file use should agree on the global function's canonical declaration and callable metadata. |
| Imported functions | Definition and references prefer the canonical source declaration; hover may stop at imported declaration/type metadata; signature help can use imported function types or fall back to display strings. | Imported function hover, definition, references, rename eligibility, and signature help should be derived from one imported-target normalization step. |
| Ambient declarations | Definition has ambient imported-symbol handling; signature help has separate ambient overload handling; hover can depend on imported declaration enrichment; rename support is limited or unsupported. | Supported ambient targets should share one declaration location and metadata source, while unsupported ambient rename should fail clearly. |
| Default imports | Definition, ambient module lookup, and signature help each unwrap default/export-equals shapes independently. | Default import resolution should identify whether the target is the local binding, default export, or export-equals symbol before feature output is built. |
| Namespace imports | Namespace member definition, hover/member completion, and signature help walk namespace/export shapes through separate helpers. | Namespace object and namespace member targets should carry owner/container metadata shared by navigation and signature help. |
| Class members | Local member rename/references use `Analysis`; cross-file definition/hover/references use member-specific lookup; signature help consults `classResolver.ts` for callable methods. | A method or field should have one member identity with class owner information across local and cross-file features. |
| Interface members | Member hover/definition and completion can resolve interface shapes through type-resolution helpers; signature help separately treats callable interface members. | Interface members should expose consistent owner information, declaration ranges, and callable signatures. |
| Extension members | Operator and extension-member navigation is handled in local analysis paths, while cross-file member logic and signature help have separate method-call assumptions. | Extension members should resolve to the same declaration and display metadata regardless of whether the request is hover, definition, references, rename, or signature help. |
| Constructors | Definition-like requests resolve type/class targets, while signature help has dedicated constructor-signature extraction and overload selection. | Constructor calls should resolve both the class declaration target and constructor callable metadata through one target model. |
| Overloads | Signature help keeps overload lists and active overload selection; hover/definition/reference paths do not expose the same overload metadata. | Overloaded functions, methods, constructors, and ambient members should preserve overload metadata for hover/signature help without changing navigation identity. |
| Documentation-comment parameter references | Hover, definition, references, and rename have custom local support; document highlights bypass that path. | Documentation parameter references should resolve to the same parameter identity for every local feature that supports them. |
| Single-file cases | Prepare rename and highlights are local-only; other features may still route through cross-file first and then fall back to `Analysis`. | Single-file projects should exercise the same shared target entry point as multi-file projects, even when no project index lookup is needed. |
| Cross-file cases | Definition/references/rename rely on cross-file context and project-index scans; hover/signature help can stop at local or imported metadata without confirming the same canonical symbol. | Cross-file requests should resolve the same canonical target before scanning references, building hover text, or extracting callable signatures. |
