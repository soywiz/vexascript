# LSP Resolution Paths

This document maps the resolution paths that existed before the shared cursor-target model work. It is intended as the baseline for the LSP unification plan in `docs/tasks/lsp.unifications.md`.

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

## Known inconsistent cases to preserve as migration tests

The unification work should add cross-feature tests for each of these before deleting old fallbacks:

- Local functions: definition/hover/references use `Analysis`; signature help uses semantic function types and display fallbacks.
- Imported functions: definition/references prefer canonical source symbols; hover and signature help still use separate member/import/type paths in some cases.
- Ambient declarations: definition has ambient imported symbol handling; signature help has ambient overload handling; rename support is intentionally limited.
- Default imports and namespace imports: cross-file definition, ambient member definition, and signature help each unwrap export/namespace shapes separately.
- Class, interface, extension, and structural members: definition/hover/references each run member-specific lookup logic.
- Constructors and overloads: signature help has richer overload selection than definition/hover metadata.
- Documentation-comment parameter references: definition/hover/references/rename have custom local support, while document highlights do not share that path.
- Single-file versus cross-file cases: server routing commonly tries cross-file first, then local `Analysis`; prepare-rename and highlights remain local-only.
