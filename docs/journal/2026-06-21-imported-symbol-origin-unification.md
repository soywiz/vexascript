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

## Regression guidance

- If an imported symbol has a stable resolved type, treat "no definition" as a
  likely architectural drift, not only as a missing edge case.
- Prefer storing declaration origin during import resolution over reconstructing
  it later in feature-specific code.
- When fixing one imported-binding regression, add a focused test that proves
  type resolution and navigation agree for the same binding.
- Keep full `pnpm test` and `pnpm cli vexa testFixtures/sample.vx` mandatory,
  because these cross-surface drifts are easy to miss with only narrow tests.
