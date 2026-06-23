# Unify Declaration Origin Tracking

## Status

* [ ] Active

## Update 2026-06-23: symptoms already resolved; remaining work is code unification

Regression tests added this pass show the user-facing symptoms are **already
fixed** by the imported-symbol-origin / `nodeModulesTypings` work:

* `compiler/lsp/crossFileDeclaredMemberDefinition.test.ts` — "resolves a member
  declared behind an export-star barrel to its source file" passes: member
  definition through `export *` lands in the deep source file, not the barrel.
* `compiler/lsp/objectLiteralBarrelDefinition.test.ts` — object-literal property
  definition through an `export *` barrel lands in the source file, not the
  barrel.

So this task no longer fixes a bug; the remaining value is purely the **code
unification** below (one shared `DeclarationOrigin` model, removing feature-local
path reconstruction). That is optional refactoring in a fragile area — weigh it
against regression risk before doing it, and prefer subtractive changes.

## Context

Recent Pixi LSP debugging exposed a structural weakness in cross-file declaration handling:

* `AnalysisSession.externalDeclarations` stores declaration statements without a canonical source path per statement.
* Re-export barrels can make the LSP pair a declaration range from the final target file with the barrel file path that originally introduced the package.
* Go to definition can therefore land at a fallback position, such as the end of `node_modules/pixi.js/lib/index.d.ts`, instead of the actual declaration in a deeper `.d.ts` file.

This showed up with object-literal member navigation such as `TextStyle({ fontSize: 24 })`, where hover knew the member type but definition still opened the package barrel.

## Goal

Introduce one shared declaration-origin model that carries both the AST node and the source file that owns that node. LSP features should consume that model instead of separately reconstructing paths or assuming that a declaration found through a barrel belongs to the barrel file.

This task owns statement-to-file origin tracking. It is complementary to
`docs/tasks/unify-imported-symbol-resolution.md`, which should unify the
type/display/declaration result for imported bindings themselves.

## Proposed Shape

Add a shared representation similar to:

```ts
export type DeclarationOrigin = {
    statement: Statement
    filePath: string
}
```

The exact name and structure can change during implementation, but the important invariant is that a declaration node and its owning file path travel together.

## Scope

* [ ] Replace pathless external declaration collections with source-aware declaration entries.
* [ ] Make package, ambient, and project declaration loaders return the same declaration-origin shape where practical.
* [ ] Update definition, hover, object-literal completion, imported declaration collection, class/member resolution, and semantic diagnostics to preserve declaration origins instead of passing raw `Statement[]` where a source path may matter.
* [ ] Remove feature-local fallback pairing of declaration ranges with module entry paths when the owning file is known.
* [ ] Prefer consuming canonical declaration-origin records from shared imported-symbol resolution instead of recomputing owner paths inside each LSP feature.
* [ ] Keep the implementation browser-compatible and asynchronous, following the repository I/O policy.

## Acceptance Criteria

* [ ] Go to definition for Pixi `TextStyle({ fontSize: 24 })` lands in the real `TextStyle.d.ts` declaration, not the package `index.d.ts` barrel.
* [ ] Go to definition for Pixi `Text({ text: "..." })` lands on the real declaration file.
* [ ] Member navigation through `export *` barrels preserves the original declaration path.
* [ ] Object-literal diagnostics, hover, completion, and definition agree on the same resolved member declaration.
* [ ] Existing ambient/runtime declaration navigation keeps working without introducing node-only dependencies.

## Tests

* [x] Add LSP regression tests for object-literal property definition through a package export-star barrel. (`objectLiteralBarrelDefinition.test.ts`)
* [x] Add regression coverage for member definition where the declaration statement comes from a different file than the package entry point. (`crossFileDeclaredMemberDefinition.test.ts`)
* [ ] Add a test proving hover and definition use the same declaration origin for imported object-literal members.
* [ ] Add coverage proving the same declaration origin survives through both imported symbol typing and later navigation.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `compiler/lsp/crossFileDeclaredMemberDefinition.ts`
* `compiler/lsp/objectLiteralCompletion.ts`
* `compiler/lsp/importedDeclarations.ts`
* `compiler/lsp/nodeModulesTypings.ts`
* `compiler/lsp/crossFileTypeResolution.ts`
* `compiler/lsp/classResolver.ts`
* `docs/tasks/unify-imported-symbol-resolution.md`
