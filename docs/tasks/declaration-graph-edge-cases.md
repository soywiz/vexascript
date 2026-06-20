# Cover Declaration Graph Edge Cases In Imported Packages

## Status

* [ ] Active

## Context

A meaningful slice of remaining interoperability problems no longer comes from parsing one declaration file. It comes from how modern packages distribute and connect declaration files:

* `exports` maps with `types` branches,
* subpath entrypoints,
* `typesVersions`,
* `export =` + namespace merges,
* sidecar `.d.ts` files next to `.js`,
* and multi-hop reexport graphs that mix CommonJS and ESM conventions.

VexaScript already handles many common patterns, but the declaration loader is still forced to special-case too many package shapes, and unsupported edge cases can silently turn otherwise-valid imported APIs into partial or missing type graphs.

## Goal

Make imported package declaration loading and resolution more resilient across the remaining package-layout edge cases that modern npm libraries use.

## Scope

* [ ] Audit the remaining unresolved package-layout patterns that are not covered by current `nodeModulesTypings` tests.
* [ ] Expand support for `typesVersions`, `exports`, and subpath typing cases that still fail or require package-specific assumptions.
* [ ] Tighten `export =` handling when the exported symbol is also merged with namespace members or support declarations.
* [ ] Improve default-import typing behavior when the runtime module shape and declaration export shape differ.
* [ ] Preserve reexport-origin tracking well enough that diagnostics, hover, and definition stay coherent after more complex declaration loading.
* [ ] Add small synthetic fixtures for each supported package-layout pattern before relying on ecosystem packages alone.

## Acceptance Criteria

* [ ] The imported declaration loader covers more package-layout families through shared logic instead of ad hoc fixes.
* [ ] New package-layout regressions can usually be reproduced with small synthetic fixtures.
* [ ] Hover/definition/diagnostics keep coherent origin tracking after the extra declaration graph patterns are supported.

## Tests

* [ ] Add focused `compiler/lsp/nodeModulesTypings.test.ts` coverage for each new package-layout family.
* [ ] Keep existing node_modules resolution tests passing.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `compiler/lsp/nodeModulesTypings.ts`
* `compiler/lsp/importedDeclarations.ts`
* `compiler/lsp/declarationResolver.ts`
* `compiler/runtime/moduleGraph.ts`
* `compiler/nodeModuleImportResolution.ts`
