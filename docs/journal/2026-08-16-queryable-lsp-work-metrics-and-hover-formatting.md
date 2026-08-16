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

The first namespace implementation also treated the start of the imported
module as the final definition. That made `z` open `external.d.cts:1`, even
though that file contains exports but no declaration named `z`. A namespace
binding is declared by the identifier in `import * as z`, and a namespace
re-export is declared by the identifier in `export * as name`. Navigation now
returns those exact identifier ranges. Module-start locations are suitable for
module-path navigation, not symbol navigation; conflating the two produces a
plausible-looking file with a semantically false range.

The node_modules path also exposed a declaration-format bug. A `.d.cts` file
importing `./external.cjs` was resolved to `external.d.ts` even when
`external.d.cts` existed. The shared declaration graph now preserves CommonJS
and ESM declaration formats (`.cjs` to `.d.cts`, `.mjs` to `.d.mts`) before
falling back to ordinary `.d.ts` files. Regression coverage includes the real
Zod package chain, not only a synthetic local barrel.

Member navigation had a related provenance gap. `PublicUserSchema.parse` had a
correct inherited Zod signature in hover, but definition lookup searched only
packages imported directly by `main.vx`. Because Zod entered through the local
`schemas.vx` barrel, that search found nothing and local fallback returned an
unrelated range in `main.vx`.

The durable source of truth is the resolved receiver type plus the external
declarations already loaded for that session. Member lookup now follows the
receiver's nominal alias/inheritance chain through those declarations and uses
their recorded file origins. For structural mapped types it also retains the
per-property declaration owner rather than searching packages by member name.
The exact Zod regression asserts that `parse` navigates to the member declared
by `ZodType` in `v4/classic/schemas.d.cts`, including its line and column.

## Namespace re-export provenance

Nested imported types exposed one more distinction between correct semantic
shape and correct source provenance. `z.core.$ZodIssue` crosses a named import,
a namespace binding, an `export * as core` boundary, and another export-star
barrel. Qualified-type navigation previously split at the last dot and looked
for an imported receiver named `z.core`; only `z` is an import binding, so the
lookup never started. Qualified package types now resolve from the imported
root and pass the remaining member path through the same node_modules type
path used by import types.

The first successful member lookup still returned coordinates from
`errors.d.cts` paired with the path of `core/index.d.cts`. Namespace re-exports
are represented by a synthetic namespace AST so the type checker can consume
them, but the synthetic wrapper had collapsed every nested declaration onto
the wrapper's file. This produced especially misleading definition results:
the correct line number in a file that did not contain that line or symbol.

Node-module declaration entries now retain the original entry tree underneath
synthetic namespaces. Both direct package navigation and the external
declarations installed into an analysis session consume that same provenance
tree. Regression coverage verifies the type alias itself and an inherited
member of a union alias: `$ZodIssue` and `message` both land in
`v4/core/errors.d.cts`, while hover remains a syntax-highlighted TypeScript
code block. A package-level unit test covers the namespace/barrel mechanics
without the cost of loading Zod, and the real multi-file Zod test covers the
complete editor session.

## Conditional generic methods and polymorphic `this`

Zod's `refine` exposed a separate inference failure that explicit result
annotations had hidden. Its return type is a generic conditional:
`Ch extends predicate ? this & ZodType<R, ...> : this`. The loose method-type
reader treated that text as an ordinary generic name and retained only a
fragment ending in `: this`. Consequently `EvenSchema` degraded to a malformed
type and `EvenSchema.parse(8)` inferred `unknown`.

Conditional method returns are now preserved as deferred type expressions.
After call arguments infer the method type parameters, the normal conditional
resolver selects the branch and substitutes polymorphic `this` with the actual
receiver. This is compiler behavior rather than a Zod/refine catalog: the
minimal regression uses a generic `NumberSchema` interface with the same
TypeScript type construct.

The first receiver substitution ran for every member call and nearly doubled
the real Zod editor test. The queryable work bounds did not fail, but elapsed
time made the duplicated semantic work visible during focused validation.
Substitution now runs only when the callable type actually references `this`.
The Zod test returned to its prior cost while still inferring `ZodNumber` and
`number`.

Member hover also used the unspecialized declaration after the call itself had
been inferred correctly. Hover now reuses the selected call resolution and its
actual expression return type, so generic calls display their instantiated
parameter and return types. `EventSchema.parse` shows the discriminated union,
and `EvenSchema.parse` shows `number`, matching the inferred variables instead
of presenting `unknown` from a parallel hover path.

Final validation exposed an unrelated race in the CLI `serve --open` test. The
fake browser used `writeFile`, so the polling reader could observe the newly
created output file before its URL contents were visible and immediately try
to parse an empty string. The test now waits for non-empty content without
weakening its URL assertions, applies the same timeout to empty and missing
files, and registers the child-process close listener before killing it. This
keeps a failed browser launch from turning a useful assertion into a hung test.
