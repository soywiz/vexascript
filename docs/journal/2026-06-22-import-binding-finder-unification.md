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

## Tests

- `compiler/lsp/crossFileContext.test.ts` (new): unit coverage for the shared
  enumeration and both node-identity and by-name finders.
- `compiler/lsp/importedDeclarations.test.ts`: added a regression that resolves
  an ambient type reference through a *renamed* named import
  (`import { PathLike as P }`), locking exported-vs-local naming through the
  shared finder.
- Full `pnpm test` (2135 tests) and `pnpm cli vexa testFixtures/sample.vx`
  green.
