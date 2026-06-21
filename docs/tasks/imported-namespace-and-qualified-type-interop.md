# Fix Imported Namespace And Qualified-Type Interop

## Status

* [ ] Active

## Context

Recent ecosystem work keeps hitting one recurring family of failures: VexaScript can often locate imported declarations, but it still loses fidelity when those declarations are exposed through namespace-shaped values, namespace-qualified type names, or merged value/type exports.

Concrete symptoms already observed include:

* namespace-style exports such as Zod's `z`,
* imported namespace members that remain visible in some LSP surfaces but not others,
* and libraries whose public API depends on qualified type names or merged namespace/value shapes.

This is separate from general conditional or mapped-type support. Even when the underlying types are simple enough, the import/export plumbing can still drop them before analysis and assignability get a chance.

## Goal

Make imported namespace-shaped APIs and qualified imported type references behave consistently across analysis, hover/completion, diagnostics, assignability, and runtime-oriented sample coverage.

This task focuses on namespace-shaped and qualified imported APIs as the user
visible symptom family. The deeper shared-resolution work is tracked in
`docs/tasks/unify-imported-symbol-resolution.md`.

## Scope

* [ ] Tighten support for `export { x }` patterns backed by imported namespace bindings.
* [ ] Preserve namespace-qualified imported type names across declaration collection and semantic resolution.
* [ ] Support more merged namespace/value export shapes for imported libraries.
* [ ] Keep default, namespace, and named import handling aligned when they refer to the same underlying declaration graph.
* [ ] Reduce cases where hover/completion know a namespace member but diagnostics or assignability still see `unknown`.
* [ ] Reduce cases where imported namespace members have a usable type but still lack hover or go-to-definition.
* [ ] Add focused regression tests for imported namespace value members and imported namespace-qualified type aliases.

## Acceptance Criteria

* [ ] Namespace-shaped package APIs like Zod stop depending on special-case regressions and resolve through the shared imported-declaration path.
* [ ] Imported qualified type names remain structurally useful in analysis instead of degrading during later stages.
* [ ] Hover, completion, and diagnostics agree on imported namespace members.
* [ ] Hover and go to definition also agree on imported namespace members whenever the declaration graph exposes an origin.

## Tests

* [ ] Add focused tests in `compiler/lsp/importedDeclarations.test.ts`.
* [ ] Add semantic regressions in `compiler/analysis/Analysis.generics.test.ts` or a more focused imported-typing test file.
* [ ] Keep `samples/zod/` passing.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `compiler/lsp/importedDeclarations.ts`
* `compiler/lsp/nodeModulesTypings.ts`
* `compiler/analysis/TypeChecker.ts`
* `compiler/analysis/typeNames.ts`
* `samples/zod/`
* `docs/tasks/unify-imported-symbol-resolution.md`
