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

## Regression guidance

- If an imported symbol has a stable resolved type, treat "no definition" as a
  likely architectural drift, not only as a missing edge case.
- Prefer storing declaration origin during import resolution over reconstructing
  it later in feature-specific code.
- When fixing one imported-binding regression, add a focused test that proves
  type resolution and navigation agree for the same binding.
- Keep full `pnpm test` and `pnpm cli vexa testFixtures/sample.vx` mandatory,
  because these cross-surface drifts are easy to miss with only narrow tests.
