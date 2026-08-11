# JSX intrinsic editor navigation must reuse contextual analysis

## Symptom

Preact intrinsic JSX was type-checked correctly enough to infer
`event.currentTarget` as `HTMLButtonElement` in completion and diagnostics, but
the editor surfaces disagreed:

- `<button` and `onClick` had no useful hover or definition;
- HTML tag completion was missing;
- `event.currentTarget` completed correctly, while hover displayed `unknown`
  and definition returned nothing.

## Root cause

The type checker resolved `JSXInternal.IntrinsicElements` to validate attribute
values, then discarded the declaration identity needed by navigation. It only
recorded JSX attribute symbols for destructured user components. Completion,
hover, and definition therefore reconstructed related information through
separate paths.

Contextual lambda analysis also revisited `event` with its specialized generic
type, but member hover and definition read the earlier expression-type entry
instead of the latest identifier resolution. Once the specialized event alias
expanded to a structural object, navigation also lacked a path back to a
property declared inside a `node_modules` type alias.

## Fix

The checked analysis now retains intrinsic tag and attribute resolutions. The
same data powers tag/attribute hover, definition, and intrinsic completion.
Intrinsic tags retain their concrete DOM element type when the JSX props type
contains one, so `button` resolves to `HTMLButtonElement`.

Member navigation now asks `Analysis` for the refined expression type, which
prefers the latest non-unknown identifier resolution. Structural member
navigation can locate properties inside imported type-alias source ranges as
well as interfaces and classes.

## Investigation notes

Reading only the expression-type map was insufficient: it preserved the loose
or unsubstituted pass even though visible-symbol completion already had the
specialized parameter. Parsing the refined structural type initially still
missed `currentTarget` because the textual member parser treated `readonly` as
part of the property name. After stripping the modifier, hover worked, but
definition still needed the type-alias source-location fallback described
above.

## Regression protection

`compiler/lsp/jsxEditorFeatures.test.ts` exercises the public LSP entrypoints
with a realistic temporary Preact package and DOM declaration source. It covers
hover and definition for the intrinsic tag, intrinsic attribute, and contextual
event member, plus combined intrinsic/component tag completion.
