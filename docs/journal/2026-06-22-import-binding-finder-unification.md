# Import Binding Finder Unification

## Context

Continuation of the imported-symbol-resolution unification workstream
(`docs/tasks/unify-imported-symbol-resolution.md`). The narrow type/display
maps were already deleted in earlier slices; the remaining direction was
"collapse remaining bespoke navigation/type bridges into the same model".

## What was duplicated

Three separate helpers each re-implemented "scan import statements and match a
binding", with their own handling of the default / namespace / named-specifier
cases:

- `findImportForSymbolNode` (crossFileContext.ts) — match by AST node identity,
  returns `{ from, name, localName }`.
- `findModuleReceiverImport` (crossFileContext.ts) — match by local name,
  returns `{ from }`.
- `findAmbientImportedTypeReference` (importedDeclarations.ts) — match by local
  name, returns `{ importPath, importedName }`, but **only iterated named
  specifiers** (ignored default/namespace imports).

That last divergence is exactly the kind of per-feature branch the design
principles warn against: a type reference whose base name came from a default or
namespace import silently fell through to `namedType(baseName)` instead of
resolving like every other import.

## What helped

Introduced one canonical enumeration in `crossFileContext.ts`:

- `ImportBinding` — `{ localNode, importedNode, from, importedName, localName }`
- `importStatementBindings(importStatement)` — yields every binding a statement
  introduces
- `importBindings(statements)` — yields bindings across a statement list
- `findImportBindingByLocalName(statements, localName)`

`findImportForSymbolNode` and `findModuleReceiverImport` now read from that
enumeration, and `findAmbientImportedTypeReference` was deleted in favor of the
shared `findImportBindingByLocalName`. Node-identity matching is preserved
exactly because `ImportBinding` keeps both the local and imported identifier
nodes (so clicking either side of `import { b as c }` still resolves).

## Behavior change to remember

Routing ambient imported type-reference resolution through the shared finder
means it now follows default and namespace imports too, not just named
specifiers. This is the more consistent behavior, and the full suite + the
pixi/zod sample regressions stayed green, but it is a real semantic widening —
if a future regression shows a bare default/namespace name resolving to a module
type where `namedType(name)` was expected, this is the cause.

## What was intentionally left alone

Two inline import scans were *not* folded in, because they have semantics the
shared by-local-name finder does not model:

- `resolveNodeModuleNamedImportType` unwraps `ExportStatement`-wrapped imports
  and carries a recursion guard.
- `resolveAmbientQualifiedImportedType` deliberately matches *namespace imports
  only* (for `A.B` qualified resolution).

Forcing them through the shared finder would have changed their matching rules,
so they stay until the shared model can express those constraints.

## Honest note on size

Raw production LOC is roughly neutral (the deleted duplicate is offset by the
new shared interface + JSDoc documenting the canonical model). The win is
structural, not line-count: there is now one place that knows what bindings an
import introduces, instead of three. Per the workstream's own warning, "elegant
cleanup here should usually look subtractive" — this slice is only mildly
subtractive in logic, so it is justified by removing a divergent branch, not by
line count.

## Follow-up slice: clause-kind enumeration + ambient finder collapse

Continuing the same direction, two more bespoke scans were removed:

- `ImportBinding` gained a `kind` field (`default` | `namespace` | `named`).
  This lets clause-specific lookups (e.g. "is this a namespace import?") read
  from the one shared enumeration instead of poking at
  `importStatement.namespaceImport` directly.
- `resolveAmbientQualifiedImportedType` (`Models.User`) now finds the namespace
  receiver via `importBindings(...)` filtered by `kind === "namespace"`.
- `findAmbientTypeAliasStatement` and `findAmbientInterfaceStatement` were near
  duplicates (same unwrap-export + match-kind-and-name loop). They now delegate
  to one `findAmbientDeclarationByKindAndName` that reuses the shared
  `unwrapExportedDeclaration` helper, so the loop exists once.

This slice is net subtractive in `importedDeclarations.ts` (−6 lines) — the
right shape for cleanup here.

Still intentionally left alone: the `resolveNodeModuleNamedImportType` inline
scan needs `ExportStatement` unwrapping plus a rename-only recursion guard, and
there are ~25 inline `ExportStatement` unwrap idioms that could later converge
on `unwrapExportedDeclaration`.

## Follow-up slice: ExportStatement unwrap convergence

The same file open-coded the "unwrap an exported declaration" idiom ~19 times:

```ts
const declaration = statement.kind === "ExportStatement"
  ? (statement as { declaration?: Statement }).declaration ?? statement
  : statement;
```

That is exactly `unwrapExportedDeclaration(statement) ?? statement` (and the few
variants that omitted the `?? statement` fallback are exactly
`unwrapExportedDeclaration(statement)`, because the downstream code already used
optional `declaration?.kind` access). All 19 were converted to the shared
`unwrapExportedDeclaration` helper, removing ~57 lines net. The conversion was
done with an anchored regex keyed on the distinctive
`(X as { declaration?: Statement }).declaration ?? X` shape and a backreference
to the variable name, so it could not touch the two non-idiom sites that look
similar: the `&& (...).declaration?.kind === "ImportStatement"` detector and the
plain `if (statement.kind === "ExportStatement")` guards.

This is purely behavior-preserving (the full suite cannot distinguish it), so its
value is the single source of truth for unwrapping, not new coverage.

## Higher-value target identified (not yet done)

`resolveAmbientNamedImportType`, `resolveAmbientNamedImportDisplayType`, and
`ambientModuleHasNamedExport` share one traversal skeleton (candidate modules →
direct export match → `export =` namespace body → var-typed interface members)
and differ only in what they project at each match (an `AnalysisType`, a display
string, or a boolean) and how they combine results. This is the real parallel
implementation to collapse next — but it is riskier than the slices above
because the display path has small asymmetries (it does its own function-only
namespace search and skips the direct `extractDirectTypeForName` step). A safe
unification needs a visitor/projector with per-consumer hooks plus tests that
pin the current display output *before* refactoring, so it deserves its own pass.

## Tests

- `compiler/lsp/crossFileContext.test.ts` (new): unit coverage for the shared
  enumeration, the `kind` tag, and both node-identity and by-name finders.
- `compiler/lsp/importedDeclarations.test.ts`: added regressions that resolve an
  ambient type reference through a *renamed* named import
  (`import { PathLike as P }`) and a *namespace-qualified* type through a
  namespace import (`import * as Models` → `Models.User`), locking the shared
  enumeration paths.
- Full `pnpm test` (2137 tests) and `pnpm cli vexa testFixtures/sample.vx`
  green.
