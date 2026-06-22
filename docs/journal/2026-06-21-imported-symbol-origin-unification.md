# Imported Symbol Origin Unification

## What failed

We kept hitting the same family of regressions with imported ecosystem symbols:

- type analysis could know what an imported binding was
- hover sometimes still produced something useful
- but go-to-definition could fail for the same binding

The visible user symptom was the recurring class of failures where a package API
looked semantically understood but navigation said there was no definition.

That is exactly the wrong kind of split for editor confidence, because once the
compiler has built a useful imported type, users expect hover and definition to
land on the same thing.

## Root cause

The imported-symbol pipeline was still split into several partially overlapping
products:

- `externalDeclarations`
- `importedSymbolTypes`
- `importedSymbolDisplayTypes`
- later, feature-local navigation logic

That meant we could successfully resolve:

- the meaning of an imported binding

without persisting:

- where that binding came from, in a canonical reusable form

So navigation often had to reconstruct declaration ownership later with its own
heuristics. That extra lookup path drifted from the richer import analysis and
produced the repeated "types work, definition does not" failures.

## What helped

The first useful architectural slice was not a giant rewrite. It was to make
the existing import collection pass carry one more shared artifact:

- `importedSymbolDeclarationOrigins`

That map now records, per local imported binding:

- the originating declaration statement
- the source file path
- the exported name

Then the LSP session cache transports that same map, and cross-file definition
resolution consults it before falling back to the older bespoke paths.

This improved two things at once:

- imported local-module bindings no longer need definition lookup to rediscover
  their declaration independently
- node_modules aliased exports such as `export { objectType as object }` can
  reuse the same collected origin instead of depending only on a later
  navigation-specific reconstruction

## What did not need changing

- the core type checker architecture
- sample code
- broad ecosystem-specific special cases

The key win came from carrying the declaration origin through the same shared
imported-symbol pipeline that already produced the type information.

## Remaining gap

This is not the end state yet.

Hover and some other LSP surfaces still rely on partially separate downstream
machinery. The first slice removes one of the highest-friction divergences, but
the broader follow-up is still the right direction:

- one imported-symbol resolution product
- multiple LSP features reading that same product

## Second step

The next useful reduction was to stop writing four parallel collections during
import analysis:

- imported symbol types
- imported symbol display strings
- imported symbol declaration origins
- invalid imported bindings

Those are now modeled first as one shared `importedSymbols` map, with the older
maps derived from it for compatibility.

That does not remove every legacy path yet, but it changes the direction of the
architecture:

- the collector writes one source of truth
- older consumers can keep working during the migration
- newer consumers can read the richer shared record directly

The most important follow-up from here is to keep deleting direct reads of the
parallel legacy maps as each feature is migrated.

## Process failure to remember

This workstream also exposed a process smell, not only a code smell.

Several rounds moved in the right architectural direction, but they still added
 much more code than they removed. That creates exactly the kind of risk we are
 trying to reduce:

- more compatibility plumbing
- more state to keep synchronized
- more places where the old and new paths can diverge

The important lesson is that "unification" is not achieved just by adding a new
 shared abstraction. If the old branches remain in place, most of the
 complexity remains in place too.

For future work in this area:

- treat additive refactors as incomplete unless they also retire old branches
- prefer understanding the old path deeply enough to delete it
- favor the more direct and durable simplification over migration-heavy
  scaffolding
- be suspicious of changes that claim DRY or unification benefits while mostly
  increasing total code volume

In short: elegant cleanup here should usually look subtractive, not additive.

## Destructive cleanup that finally mattered

The next cleanup step was valuable precisely because it removed API surface
instead of only documenting a future intention.

We deleted two live compatibility branches:

- `AnalysisSession` no longer stores or accepts a separate
  `importedSymbolDeclarationOrigins` map
- `collectAllImportedDeclarations(...)` no longer exposes
  `importedSymbolDeclarationOrigins` as a parallel public result

After that change, declaration origin in live code flows only through:

- `importedSymbols.get(name)?.declarationOrigin`

This matters more than the raw line count suggests. The main win is that new
callers can no longer accidentally wire the old origin map while forgetting the
shared imported-symbol record, because that separate route no longer exists.

That is the standard to keep applying in this area:

- remove compatibility parameters from shared constructors as soon as runtime
  production code stops using them
- remove legacy derived views from public return shapes once only tests depend
  on them
- update tests to assert the canonical structure instead of protecting legacy
  plumbing forever

## Next destructive slice

The next worthwhile cut was smaller but cleaner in a very important way:

- `AnalysisSession` stopped storing `importedSymbolTypes` and
  `importedSymbolDisplayTypes` as duplicated session state

Those narrower maps still exist locally when building an analysis because the
underlying analysis pipeline still accepts them, but they no longer survive as
long-lived LSP session fields.

That changed two things:

- production LSP code now treats `session.importedSymbols` as the canonical
  imported-binding state
- reconstruction tests that still need the older constructor shape now carry
  that compatibility locally instead of forcing production session objects to
  keep duplicated fields alive forever

This is a good example of the desired migration direction:

- temporary compatibility may still exist at the construction boundary
- but it should retreat out of persistent runtime state first

## Binder boundary cleanup

The next cleanup moved the same idea one boundary deeper:

- `Binder` no longer accepts `importedSymbolTypes` and
  `importedSymbolDisplayTypes` as separate constructor inputs

Instead:

- `Analysis` now normalizes any legacy imported-symbol maps into one
  `importedSymbols` representation
- `Binder` consumes only that canonical representation

This is a better architecture cut than deleting every legacy option at once,
because it removes duplication from the deeper semantic core first:

- fewer live internal paths reach binding
- imported symbol type/value display fallback logic is centralized at the
  `Analysis` boundary
- compatibility is pushed outward toward the edges instead of inward toward the
  core

## Shared normalization cleanup

Another important cleanup was deleting the repeated local normalization logic
for imported bindings that had quietly spread across:

- `Analysis`
- `AnalysisSession`
- runtime transpilation
- import collection helpers

That duplication was especially risky because each copy was small enough to
look harmless, but together they created several places where:

- `type`
- `displayType`
- invalid-binding state
- declaration origin

could drift or be normalized slightly differently.

The fix was to make one shared compiler-level module responsible for:

- normalizing legacy imported-symbol inputs into canonical `importedSymbols`
- deriving narrow compatibility views from that canonical map when still needed

This is the kind of DRY that actually matters:

- less live duplication in production code
- fewer hidden differences between analysis/runtime/LSP paths
- a clearer next step for deleting the remaining legacy narrow-map APIs

## Positional session API removal

The next cleanup removed a different kind of duplication: the long positional
`createAnalysisSession(...)` argument list.

That old API had become a compatibility trap because callers had to pass
placeholder `new Map()` / `new Set()` / `[]` values just to reach the one piece
of context they cared about. It made call sites hard to read and encouraged
tests to keep wiring legacy narrow maps because that was the historical
parameter order.

The session factory now takes named options instead. That keeps simple calls as
`createAnalysisSession(source)` while making richer calls explicit about what
they provide:

- external declarations
- ambient declarations
- imported symbols
- invalid imported bindings

The useful lesson here is that compatibility debt can hide in function
signatures, not only in data structures. If a factory needs many unrelated
positional placeholders, it is usually preserving an old migration path.

## Removed imported-symbol helper

After the shared imported-symbol map became the canonical collector output, the
standalone `collectImportedSymbolTypes(...)` helper was only protecting the old
view.

That helper is now deleted. Tests that still need the derived symbol-type view
read it from `collectAllImportedDeclarations(...)`, and one test whose only job
was comparing the combined path against the old separated helper path was
removed.

That deletion matters because future call sites now naturally choose the
single-pass collector that also carries declaration origins and invalid-binding
state. The type-only helper no longer invites new code to resolve imports once
for types and then rediscover declaration ownership later.

## Regression guidance

- If an imported symbol has a stable resolved type, treat "no definition" as a
  likely architectural drift, not only as a missing edge case.
- Prefer storing declaration origin during import resolution over reconstructing
  it later in feature-specific code.
- When fixing one imported-binding regression, add a focused test that proves
  type resolution and navigation agree for the same binding.
- Keep full `pnpm test` and `pnpm cli vexa testFixtures/sample.vx` mandatory,
  because these cross-surface drifts are easy to miss with only narrow tests.

## Session input unification

The next safe destructive slice was to close the LSP session boundary itself:

- `createAnalysisSession(...)` no longer accepts `importedSymbolTypes`
- `createAnalysisSession(...)` no longer accepts `importedSymbolDisplayTypes`
- `ResolvedExternals` from `AnalysisSessionCache` no longer accepts those
  narrow maps either

Callers now pass `importedSymbols` into sessions. That means hover, definition,
signature help, semantic diagnostics, and completions all receive the same rich
imported-binding record instead of each caller choosing a narrower view.

The important dead end in this round was trying to delete the lower-level
`Analysis` / `TranspileOptions.importedSymbolTypes` compatibility at the same
time. That broke the CLI bundler for untyped CommonJS packages such as the
`tiny-cjs` fixture, because runtime bundling can still carry an invalid imported
symbol as a tolerated JavaScript import while LSP diagnostics need explicit
invalid-binding reporting.

At that point, the durable boundary was:

- LSP sessions are canonical and rich-only
- lower compiler/transpile inputs still keep legacy narrow maps until the
  bundler/runtime path is migrated deliberately

This preserves the real CLI contract while still preventing new LSP code from
reintroducing duplicated imported-symbol session state.

## Lower imported-symbol input cleanup

The lower compiler/transpile boundary now deletes the same type/display
compatibility inputs too. `AnalysisOptions`, `TranspileOptions`, and
`ImportedSymbolSources` accept `importedSymbols`, while the narrow
`importedSymbolTypes` and `importedSymbolDisplayTypes` maps remain only as
derived outputs where old consumers still need them.

The guardrail from the failed attempt remains: keep `invalidImportedBindings`
as the explicit semantic signal to `TypeChecker`. Do not infer semantic invalid
imports merely from `importedSymbols.invalid`, because runtime bundling can
still tolerate untyped JavaScript/CommonJS imports that LSP diagnostics should
report only when the invalid-binding set says so.

## Collector output cleanup

The collector now removes the final type/display compatibility output maps too.
`collectAllImportedDeclarations(...)` returns `importedSymbols` plus
`invalidImportedBindings`; tests that need the imported type or display text read
`importedSymbols.get(name)?.type` or `.displayType`. This keeps collector tests
useful while making the old narrow maps impossible to consume accidentally.

## Type-string navigation gap

`z.infer<typeof UserSchema>` exposed another drift: analysis could use the type
text, but LSP navigation did not visit `TypeAliasStatement.targetType` and
treated qualified type text such as `z.infer` as one opaque name. The fix was to
let the shared type-identifier finder visit alias targets, return the qualified
name with a segment range, and let hover/definition resolve that synthetic type
identifier through the same node_modules export and local-symbol paths.

## Imported value origins in type queries

`typeof importedValue` exposed a second split in the same area. The imported
symbol had a usable type, so hover could report the value shape, but
go-to-definition could not jump to the package declaration because node_modules
origin collection did not record inline value exports such as
`export declare const value: Type`. The fix was to preserve the local import
name when recognizing import bindings, reuse imported declaration origins from
type-identifier navigation, and record inline value export names when building
node_modules declaration origins.

## Default import origins in type queries

A follow-up stress pass found the same type/definition drift for
`typeof defaultImport`. The collector already had the default import's type and
declaration origin, so hover worked, but navigation still returned the local
import binding because `findImportForSymbolNode` only recognized named import
specifiers. The fix was to make the shared import-binding helper recognize
`defaultImport` and `namespaceImport` nodes too, so expression navigation and
type-query navigation use the same imported-symbol origin path.

## Inline import-type member origins

A later stress pass found one more member of the same family:
`import("pkg").Type` and `typeof import("pkg").value`. These do not create an
import declaration, so the normal imported-symbol collector cannot record a
binding origin for them. The first useful dead end was trying to reason about
them as missing collected imports; the evidence against that was that
`externalDeclarations` was correctly empty for the file.

The better fix was to preserve the package specifier in the synthetic type
identifier produced by the shared type-string cursor finder, then resolve that
synthetic `import("pkg").member` through the existing node_modules export
location helper. That keeps the behavior aligned with normal qualified
node_modules members without adding another package-specific declaration
collector path.

The same pass then exposed `typeof import("pkg").default`. That failed for a
different but related reason: the public export name is `default`, while the
declaration range belongs to the local declaration name, for example
`export default function createSchema()`. The durable fix belongs in
`findNodeModuleExportLocation`, where default export statements can map the
public `default` export back to the declared name range for every caller.

## Exported namespace import-type paths

Another stress pass tried `import("pkg").Models.User`. The first hypothesis was
that type-string navigation only preserved one segment after `import("pkg")`.
That was true for the nested `User` segment, but the more useful failure was
earlier: even `Models` had no definition because the TypeScript parser rejected
`export namespace Models { ... }` and produced no declaration entry at all.

The fix therefore had two layers:

- parse `export namespace` / `export module` as exported namespace declarations
  in the shared parser
- preserve the full inline import-type member path so navigation can resolve
  `import("pkg").Models.User` through the existing node_modules member-location
  helper

This is a good example of why LSP bugs should be reduced through the full
infrastructure path. A navigation-looking failure was partly a parser
compatibility gap, and patching only the LSP would have left declaration-file
parsing broken for other callers.

## Aliased default reexport origins

Another pass found that `export { createSchema as default } from "./factory"`
could give a usable public type while go-to-definition landed on the barrel
specifier instead of the source declaration. The direct symptom showed up with
`typeof import("pkg").default`, but the real issue was in node_modules typings
collection: following a named reexport preserved that a declaration was
exported, but not the exact local/exported-name pair.

The first attempted fix was too narrow and accidentally broke existing renamed
reexports such as `export { b as QueryClient } from "dep"`, because older logic
also matched the public exported name as a compatibility fallback. The durable
fix was to preserve both facts:

- `localName -> exportedName`, so `createSchema` can become public `default`
- `exportedName -> exportedName`, so existing renamed-reexport flows that
  expose a declaration under its public name keep working

The resolver also must not return the barrel specifier range for `from`
reexports before it has a chance to reach the source declaration entry.

## Export-star namespace reexports

Another pass tried the TypeScript declaration-file pattern
`export * as Models from "./models"`. This was a useful counterexample because
the parser already accepted the syntax, so the failure was not another parser
gap. The node_modules typings collector treated it like a plain `export *` and
discarded the public namespace name. That meant `import("pkg").Models.User` and
`import { Models } from "pkg"` could not share the same declaration path.

The initial focused fix made inline `import("pkg").Models.User` navigation work
by creating a synthetic namespace entry whose body reuses the reexported source
declarations. A second test then showed that named imports still inferred
`unknown` for `Models.User`: `importedDeclarations` had its own older
export-name helper and `resolveNodeModuleNamedImportType` ignored
`NamespaceStatement`.

The durable fix was to converge those paths:

- expose one shared `nodeModuleExportedNamesForStatement` helper from
  `nodeModulesTypings`, including `namespaceExport`
- treat `NamespaceStatement` as an importable declaration name
- resolve named namespace imports as object types built from the namespace
  body's exported properties

The lesson is the same as the Zod/Pixi failures: parsing support is not enough.
Imported type, hover, definition, and named-import analysis all need to consume
the same declaration model, otherwise one editor feature can appear fixed while
another still sees `unknown`.
