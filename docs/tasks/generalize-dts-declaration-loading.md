# Generalize DTS Declaration Loading

## Status

* [ ] Active

## Context

The current `.d.ts` graph loading logic is most developed inside `compiler/lsp/nodeModulesTypings.ts`. That module already knows how to follow package entry points, `export *`, imports, package exports, and related declaration-file patterns well enough for real packages such as Pixi.

The problem is that this useful `.d.ts` processing is coupled to a `node_modules`-specific owner. Other declaration sources, such as ambient/runtime declarations, local declaration files, browser virtual workspaces, or future declaration providers, should not need to pretend to be `node_modules` just to reuse the same graph and origin tracking behavior.

## Goal

Extract package-independent declaration graph loading behind a small shared service. `node_modules` should become one adapter/resolution policy for that service, not the place where general `.d.ts` semantics live.

## Proposed Direction

Create a shared declaration graph loader that accepts:

* an entry file or module specifier resolution result,
* a virtual file system facade,
* a module-resolution policy,
* and parse/cache hooks already used by the compiler/LSP.

It should return a source-aware declaration graph or declaration program that can be consumed uniformly by LSP features.

## Scope

* [ ] Identify which parts of `nodeModulesTypings.ts` are general `.d.ts` graph logic and which parts are specifically package or `node_modules` resolution.
* [ ] Extract the general graph traversal, declaration parsing, re-export handling, and declaration-origin collection into a package-independent module.
* [ ] Keep bare-specifier and package-export lookup in a `node_modules` adapter.
* [ ] Route ambient/runtime declaration loading through the same declaration-entry representation where practical.
* [ ] Route browser virtual workspace declaration loading through the same representation if it needs cross-file declaration semantics.
* [ ] Preserve the virtual file system boundary so shared compiler modules do not depend on Node.js APIs.
* [ ] Update `docs/file.structure.md` if the extraction creates a new architectural module.

## Acceptance Criteria

* [ ] `nodeModulesTypings.ts` no longer owns general `.d.ts` graph semantics; it delegates to a shared loader.
* [ ] Declaration consumers no longer need node_modules-specific helpers just to get declaration origins or export-star traversal.
* [ ] Pixi package behavior remains unchanged or improves.
* [ ] Ambient/runtime declarations can use the same source-aware declaration entry model.
* [ ] The design supports browser execution without synchronous I/O and without Node.js dependencies in shared compiler modules.

## Tests

* [ ] Keep existing `nodeModulesTypings` regression coverage passing.
* [ ] Add focused tests for the extracted graph loader using a virtual file system.
* [ ] Add coverage for export-star traversal that is not tied to a physical `node_modules` package.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `compiler/lsp/nodeModulesTypings.ts`
* `compiler/lsp/importedDeclarations.ts`
* `compiler/lsp/ambientTypesLoader.ts`
* `compiler/lsp/crossFileContext.ts`
* `compiler/lsp/crossFileNavigation.ts`
* `compiler/vfs.ts`
