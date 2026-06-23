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

## Lesson

When hover/definition disagree with diagnostics about a member, suspect inverted
precedence between the type checker and the LSP navigation, not a missing case.
The durable fix is to make the surfaces consume the same precedence, not to patch
one surface's ordering in isolation.
