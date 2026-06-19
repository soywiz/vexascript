# Expand TypeScript Utility Type Coverage

## Status

* [ ] Active

## Context

VexaScript already resolves a small set of TypeScript-style utility types such as `Omit`, `OmitKeyof`, `Pick`, `Partial`, `Required`, and `WithRequired`.

That support is useful, but today it is intentionally shallow:

* most utilities are modeled as simple object-property transforms,
* modifier semantics are not preserved with TypeScript fidelity,
* and many of the built-in utility types used across mainstream `.d.ts` files are still unresolved or collapse to conservative `unknown`.

This gap becomes visible quickly in real package typings, where modern libraries rely on utility aliases as a core building block rather than a convenience layer.

## Goal

Support a materially broader set of TypeScript utility types with behavior close enough to real TypeScript that package declaration files stop degrading into partial or `unknown` shapes.

## Scope

* [ ] Audit which utility types are already treated specially in semantic analysis and ambient declaration loading.
* [ ] Preserve the current support for `Omit`, `OmitKeyof`, `Pick`, `Partial`, `Required`, and `WithRequired` while tightening their semantics where practical.
* [ ] Add first-class handling for common built-in utility types used heavily in ecosystem typings.
* [ ] Prioritize at least:
  * `Exclude`
  * `Extract`
  * `NonNullable`
  * `Readonly`
  * `Record`
  * `ReturnType`
  * `Parameters`
  * `ConstructorParameters`
  * `InstanceType`
  * `ThisParameterType`
  * `OmitThisParameter`
  * `Awaited`
* [ ] Decide explicitly which of these can be resolved structurally today and which need staged fallback behavior.
* [ ] Keep semantic checker behavior and ambient `.d.ts` import resolution aligned so the same utility type does not produce different shapes depending on source.
* [ ] Update `docs/syntax.md` if supported utility-type behavior becomes materially broader or more precise.

## Acceptance Criteria

* [ ] Utility-heavy declaration files no longer degrade to `unknown` merely because they reference common built-in TypeScript utility aliases.
* [ ] The same utility alias resolves consistently in local type aliases and imported ambient declarations.
* [ ] Existing support for `Omit`, `Pick`, `Partial`, `Required`, `WithRequired`, and `OmitKeyof` remains working.
* [ ] New regression coverage exists for each newly supported built-in utility family.

## Tests

* [ ] Add semantic tests for local utility-type aliases.
* [ ] Add `nodeModulesTypings` or imported-declaration tests proving the same utility types resolve through `.d.ts` files.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `compiler/analysis/TypeChecker.ts`
* `compiler/analysis/typeOperations.ts`
* `compiler/analysis/typeNames.ts`
* `compiler/lsp/importedDeclarations.ts`
* `compiler/lsp/nodeModulesTypings.test.ts`
* `docs/syntax.md`
