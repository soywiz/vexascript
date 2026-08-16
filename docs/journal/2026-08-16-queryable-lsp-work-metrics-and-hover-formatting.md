# Queryable LSP work metrics and unified hover presentation

## Symptoms

The expanded Zod sample exposed three related editor problems. Inferred aliases
occasionally collapsed to `unknown`, editor requests took several seconds, and
only type-alias hovers used highlighted multiline TypeScript while variables,
members, literals, annotations, and cross-file type queries still returned
single-line plaintext.

The sample also accepted `unknown` at its parsing boundaries. Although that is
a normal validation API shape in application code, it was a poor compatibility
test because it could conceal a failure to resolve Zod's declared input type.

## One presentation path

Hover producers had independently assembled `label: type` strings and selected
plaintext or Markdown. Fixing the type-alias branch alone therefore left the
same presentation bug in member, object-literal, annotation, documentation,
expression, and cross-file navigation paths.

The durable approach is to route code-shaped hover text through the shared
TypeScript Markdown formatter. Import-path hovers remain plaintext because they
describe resolved files rather than source declarations. Regression coverage
must include aliases, imported values, members, literals, object properties,
type queries, annotations, and documentation references so a new branch cannot
silently return to plaintext.

## Deterministic performance evidence

An initial Zod regression asserted wall-clock limits for cold and warm hover and
completion requests. That failed in CI even though the same work completed
correctly: runner load changed elapsed time without changing compiler behavior.
Increasing the timeout would only move the flaky boundary.

`AnalysisSessionCache` now retains queryable counters for synchronous and
asynchronous requests, cache hits and misses, pending-work reuse, external
declaration cache activity, resolver executions, and base/resolved session
builds. The full workspace harness adds imported-declaration collections and
project-session requests, and exposes both total and warm-request deltas. Tests
can therefore bound duplicated semantic work and prove that warm editor
requests reuse the session without using elapsed time as pass/fail evidence.

The first metric snapshot also exposed work below the analysis-session cache:
`ProjectIndex.getSessionForFilePath` performed a filesystem `stat` for every
lookup and concurrent requests could load and compile the same declaration
file independently. `ProjectIndex` now publishes its own request, cache,
pending-reuse, filesystem, and build counters. Cached disk sessions, including
negative results for missing candidate paths, remain authoritative until the
workspace watcher calls `invalidateFile`; concurrent cold loads share one
promise. This preserves change detection while removing repeated filesystem
and parser work from hover and completion bursts.

## Library-validation rule

Compatibility samples must not introduce sample-owned `any` or `unknown`
annotations, casts, declaration shims, or suppressions to get through the
compiler. The Zod parsing boundary now uses `z.input<typeof Schema>` and keeps
negative runtime values structurally typed. If a published declaration itself
contains a broad type, tests may observe that contract, but the sample must not
copy it into its own API as an escape hatch.

Running the real sample after that change exposed a hidden contextual-typing
bug: a nested value represented as the empty structural type `{}` was treated
as a complete closed shape, so `{ language: "vexa" }` received an
excess-property diagnostic against `object`. TypeScript's empty object shape
does not provide a finite property catalog for excess-property checking. Empty
`ObjectType` instances are therefore open for this check, while non-empty
interfaces and object shapes still report misspelled properties. Replacing
broad sample inputs with real library types made this compiler failure
observable instead of bypassing it.

## Canonical definition navigation

Correct type inference did not imply correct navigation. `RoleSchema` inside a
`typeof` query resolved to the local import specifier, while Zod's `z` binding
stopped at `export { z }` in the package entry point. Both failures came from
definition branches returning the first declaration-shaped node instead of
following the same import binding to its canonical source.

Import-specifier, imported-value, and type-query navigation now share one
recursive import/export resolver. It follows named and default re-exports,
local export lists, namespace imports, and export-star barrels, with cycle
protection. Explicit exports are checked before export-star fallbacks; the
first implementation used source order and the queryable work metrics exposed
an unnecessary traversal of Zod's declaration graph before reaching its
explicit `z` export.

The node_modules path also exposed a declaration-format bug. A `.d.cts` file
importing `./external.cjs` was resolved to `external.d.ts` even when
`external.d.cts` existed. The shared declaration graph now preserves CommonJS
and ESM declaration formats (`.cjs` to `.d.cts`, `.mjs` to `.d.mts`) before
falling back to ordinary `.d.ts` files. Regression coverage includes the real
Zod package chain, not only a synthetic local barrel.
