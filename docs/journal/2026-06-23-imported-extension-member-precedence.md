# Imported extension member precedence (hover/definition vs diagnostics)

## Symptom

In `samples/pixi`, `utils.vx` declares an extension property that shadows a
node_modules class member:

```
var Container.position: Vec2 { get => Vec2(x, y); set { ... } }
```

`html.vx` imports it (`import { position } from "./utils.vx"`) and assigns
`..position = center + Vec2(0, -16)`. The type checker / diagnostics resolved the
imported **extension** `position` (Vec2), but hover and go-to-definition jumped to
the built-in pixi `Container.position` (`get(): ObservablePoint`). The three
surfaces disagreed about which `position` was in effect.

## Root cause: inverted precedence (a divergence bug)

The type checker (`TypeChecker.resolveKnownMemberType`) checks extension members
**before** class members: `resolveExtensionMemberType(...)` and then
`importedExtensionPropertyTypes` come first, class/object members after. So an
imported `var Container.position` wins.

But the LSP navigation had the precedence **backwards**:

- `resolveMemberDefinitionAcrossFiles` ran `resolveDeclaredMemberDefinitionAcrossFiles`
  (class member) first and only fell back to the extension.
- `resolveMemberHoverAcrossFiles` put `extensionTypeLabel` last in its type-label
  fallback chain, behind the resolved class-member label.

Two implementations of "which member named X wins on receiver T", drifted. This
is exactly the divergence class the AGENTS.md design principles warn about: the
same decision made in two places gives different answers.

## Fix

Align both LSP surfaces with the type checker — resolve the receiver-matched
extension member **before** the class member:

- definition: try `resolveExtensionMemberDeclarationAcrossFiles` before
  `resolveDeclaredMemberDefinitionAcrossFiles`.
- hover: prefer `extensionTypeLabel` (and the extension's documentation) when a
  receiver-matched extension exists.

The receiver-matched lookup returns non-null only when an extension actually
applies, so members without an extension fall through to class resolution
unchanged — the full suite (incl. the pixi sample) stays green.

## Test

`compiler/lsp/importedExtensionMemberPrecedence.test.ts` reproduces the pixi
shape with a synthetic node_modules class `Box { position: number }` shadowed by
an imported `var Box.position: string`, and asserts the inferred type, hover, and
definition all resolve to the extension — for both plain member access and the
`..position` cascade form the sample uses.

## Gating correction (the first cut over-applied)

The first version of this fix preferred the extension over the class member
*whenever* a receiver-matched extension existed anywhere across files. That
over-applied: if a sibling export is imported from the extension's file but the
extension property itself is NOT imported (e.g. samples/pixi removing `position`
from the import while still importing `addTo`/`Vec2`), selective declaration
collection means the type checker does NOT see the extension and resolves the
class member. So the over-eager fix re-introduced divergence in the other
direction (definition/hover → extension, diagnostics → class member).

The correct gate mirrors `TypeChecker.collectExtensionProperties`, which only
registers extensions from the selectively collected `externalDeclarations` plus
the local program. `resolveInScopeExtensionMemberDeclarationAcrossFiles` now
prefers the extension only when an extension for the receiver + member name is
present in those same in-scope statements (`extensionMemberInScope`). This also
handles the rename case correctly, because it keys on the collected declarations
the analysis used, not on the local import name. Definition and hover both use
the gated resolver for the extension-over-class preference.

Regression coverage in `importedExtensionMemberPrecedence.test.ts` now pins all
three: imported → extension wins; sibling-only import → class member wins (no
divergence); and the `..position` cascade → extension wins.

## Completion was the third diverging surface

Member completion listed BOTH a `position` item (the in-scope extension) and a
`position` item (the shadowed class member). Since the type checker resolves the
extension, the class-member item is inaccessible and misleading. Fixed in
`buildMemberCompletionItemsForType` by dropping class-member items whose label is
already produced by an in-scope extension item (`extensionLabels` filter). The
existing "merge boxed Number members with extension members" behaviour is
unaffected because that case has *distinct* names — the filter only removes
genuine same-name shadows. Covered by a new completion test.

So all four surfaces — diagnostics, hover, definition, completion — now agree on
which member is in effect.

## References / rename: the fifth surface, now aligned

`resolveCanonicalMemberSymbol` (in `crossFileTypeResolution.ts`, the shared
resolver behind both find-references and rename) resolved the member class-only —
via `resolveTypeDefinitionAcrossFiles` + `classMemberInfoByName` — and never
consulted extensions, so for a shadowed member it anchored on the class member.
It now first calls `resolveInScopeExtensionMemberDeclarationAcrossFiles` (the same
gated resolver definition/hover use) and, when an in-scope extension shadows the
member, returns a canonical symbol anchored on the extension declaration. So
references and rename follow the extension too: renaming the shadowed member
renames the extension declaration plus its usages, and leaves the inaccessible
class member alone.

This makes `resolveCanonicalMemberSymbol` consume the same extension-aware
resolution as every other surface, so all five — diagnostics, hover, definition,
completion, references/rename — agree on which member is in effect. (The
crossFileTypeResolution → crossFileMemberDefinitionSources import is a runtime-safe
cycle: the resolver is only called inside an async function, never at module
evaluation.)

Regression coverage in `importedExtensionMemberPrecedence.test.ts` now also
asserts references anchor on the extension when imported, and on the class member
(not the extension file) when only a sibling export is imported.

## Lesson

When hover/definition disagree with diagnostics about a member, suspect inverted
precedence between the type checker and the LSP navigation, not a missing case.
The durable fix is to make the surfaces consume the same precedence — and that
includes the *gating*: an extension must only win where the type checker would
actually see it (the selectively collected declarations), or you just move the
divergence to the not-imported case.
