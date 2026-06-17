# LSP Cursor Target Model

This document defines the canonical cursor-target model for VexaScript LSP navigation features. It is the design baseline that guided the shared `resolveCursorTarget(...)` migration tracked historically in `docs/tasks/completed/lsp.unifications.md` and remains the reference for post-unification cleanup work.

## Goals

The model gives hover, definition, declaration, type definition, implementation, references, rename, document highlight, and signature help one shared answer to the question: "what is under the cursor?" Feature handlers should consume that shared target and then build protocol-specific output from its declaration location, symbol identity, owner metadata, callable metadata, and display metadata.

The model is intentionally an LSP-layer contract. It can compose data from `Analysis`, cross-file project sessions, ambient declaration maps, imported declaration metadata, and class/member resolvers without moving those lower-level responsibilities into feature handlers.

## Entry point contract

The future shared resolver should expose a single entry point with this shape:

```ts
resolveCursorTarget(context, document, position, options): CursorTarget | null
```

The entry point owns cursor normalization that is currently duplicated across feature handlers:

- Probe the exact cursor character and adjacent identifier/operator/import-string positions.
- Normalize member-access and implicit-receiver positions to the semantic symbol position.
- Detect documentation-comment parameter references before semantic analysis fallbacks.
- Detect annotation applications and annotation type references.
- Preserve enough syntax context to distinguish value identifiers, type identifiers, import specifiers, string import paths, namespace member paths, call expressions, constructor calls, and member expressions.

## Target kinds

`CursorTarget.kind` should use a closed set of LSP-facing target kinds. The initial set is:

| Kind | Examples | Required support |
| --- | --- | --- |
| `localDeclaration` | local functions, variables, parameters, classes, interfaces, type aliases, enum members | declaration, hover, references, rename, highlight, signature help when callable |
| `importedDeclaration` | named imports, default imports, namespace imports, re-exported declarations | source declaration navigation, imported binding metadata, rename eligibility |
| `ambientGlobal` | runtime globals, DOM globals, `global {}` declarations | declaration/hover/signature metadata; rename normally unsupported |
| `ambientModuleMember` | declarations inside `declare module`, `export =`, default export, namespace export members | declaration/hover/signature metadata; rename normally unsupported |
| `classMember` | fields, methods, accessors, constructor parameters promoted to members | owner class, member identity, callable method metadata |
| `interfaceMember` | properties, call signatures, methods | owner interface, structural member identity, callable metadata |
| `extensionMember` | extension methods, extension properties, operators | receiver type, extension declaration, callable/operator metadata |
| `annotation` | annotation declarations and applications | annotation declaration, constructor-like callable metadata when applicable |
| `documentationParameter` | `///` and block-doc parameter references | parameter identity, documentation range, local references/rename support |
| `importPath` | string literals in import/export declarations | resolved module/document location and display path metadata |
| `constructor` | `new Class(...)` or constructor declarations | class declaration identity plus constructor callable metadata |
| `unknownUnsupported` | syntactically valid but intentionally unsupported targets | reason for clear user-facing failure instead of partial rename/reference behavior |

A target may carry a `role` when the same syntax participates in multiple concepts. For example, a constructor call can have `kind: "constructor"`, a class declaration navigation identity, and callable constructor metadata; a default import can identify both the local binding and the exported declaration behind it.

## Core fields

Every non-null target should provide these fields where applicable:

| Field | Purpose |
| --- | --- |
| `sourceUri` | URI of the document where the request was made. |
| `requestRange` | Normalized range used by the feature handler for highlighting or prepare-rename. |
| `syntax` | Cursor syntax classification such as identifier, member name, type name, import path, documentation parameter, annotation, operator, or call callee. |
| `identity` | Canonical symbol identity used by references, rename, and highlights. |
| `declaration` | Canonical declaration location and selection range for definition/declaration/type-definition style requests. |
| `binding` | Local binding location when it differs from the canonical declaration, especially imports and aliases. |
| `owner` | Container metadata for classes, interfaces, namespaces, ambient modules, extension receivers, and object/type-alias members. |
| `callable` | Structured signature, overload, constructor, annotation, and active-argument metadata shared with signature help and hover. |
| `display` | Preformatted or structured label/type/detail data for hover, completion-like previews, and diagnostics. |
| `documentation` | Documentation extracted through the shared declaration-documentation helper. |
| `capabilities` | Booleans and failure reasons for supported feature operations, especially rename and references. |
| `resolutionTrace` | Lightweight debug labels for tests and future diagnostics; not intended for user display. |

## Symbol identity

`identity` is the canonical comparison key. It should not be a display string. The minimum representation is:

- `uri` and declaration range for source declarations.
- A stable ambient key for bundled runtime, DOM, and package declarations whose source may be virtual or generated.
- `exportPath` for imported or re-exported symbols, including default, namespace, and `export =` unwrap decisions.
- `memberPath` for members, including owner identity, member name/operator, static/instance classification, and extension receiver type when relevant.
- `parameterPath` for function, method, constructor, annotation, and documentation-comment parameters.

References, rename, and document highlight should compare this identity first, then use feature-specific filters only for intentionally local behavior such as highlighting in the active document.

## Declaration and binding locations

The model distinguishes these locations so features can be consistent:

- `declaration`: the canonical user-authored or ambient declaration that definition-like requests should prefer.
- `binding`: the in-file binding under the cursor, such as an import specifier or alias.
- `implementation`: an optional implementation body location when declarations and implementations diverge later.
- `typeDeclaration`: an optional type declaration location for type-definition requests when it differs from value declaration.

Imported symbol navigation should generally use `declaration`, while prepare-rename can use `binding` when renaming a local alias is supported and safe.

## Owner and container metadata

Targets for members and module exports must carry owner information instead of rediscovering it per feature. Owner metadata should include:

- Owner kind: class, interface, namespace, ambient module, object type, type alias, enum, extension receiver, or documentation block.
- Owner identity and declaration location.
- Visibility/static/instance information when available.
- Receiver type text and normalized structural type information for implicit receiver and extension-member cases.

This owner data lets hover, definition, signature help, references, and rename agree on whether `foo` means a local symbol, `this.foo`, a namespace export, an interface member, or an extension member.

## Callable metadata

`callable` should be structured enough that signature help does not need a separate resolution ladder. It should include:

- Callable kind: function, method, constructor, annotation, call signature, extension method, or ambient member.
- Ordered overloads with parameter names, optional/rest flags, type text, return type text, documentation, and declaration ranges.
- Active overload and active parameter hints when the target was resolved from a call expression.
- Display labels that can be generated from structured fields.
- A `fallbackDisplayParse` flag only when a display-string fallback was required.

Hover can summarize the active signature or overload set from the same data, while signature help can render all overloads without re-resolving the callee.

## Hover and documentation metadata

`display` and `documentation` should be built from shared declaration metadata:

- Local and cross-file declarations should use the same documentation extraction for `///` and block doc comments.
- Imported and ambient targets should retain module/export labels without changing the canonical identity.
- Member hover should include owner context from the `owner` field instead of doing feature-specific member lookup.
- Annotation and documentation-parameter targets should expose the same documentation text to hover and rename/definition tests.

## Capability policy

Unsupported operations should be explicit. `capabilities` should include:

- `definition`, `hover`, `references`, `rename`, `highlight`, and `signatureHelp` support flags.
- A short failure reason for unsupported rename/reference cases, such as ambient package declarations, generated runtime declarations, or ambiguous namespace exports.
- Whether an operation should target the canonical declaration, local binding, or both.

This prevents ambient/imported rename from half-working when only a binding or only a declaration can be edited safely.

## Migration notes

Feature handlers should migrate in the order listed in the task file: definition/declaration first, then hover, then signature help, then references/rename. During migration, old fallback paths can populate fields in `CursorTarget` before being removed. New regression tests should assert that several features in the same scenario observe the same `identity`, `declaration`, and `callable` data where applicable.
