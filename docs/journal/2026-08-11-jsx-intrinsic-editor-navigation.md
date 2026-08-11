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

## Follow-up: attribute-name completion must use the checked props map

The editor still fell back to ordinary in-scope symbols when completion was
requested after an opening tag name, for example `<Counter |` or `<div |`.
Tag-name completion only recognized text ending immediately after `<Tag`, so it
could not represent the distinct JSX attribute-name context. Decorating the
ordinary visible-symbol results would not have fixed the candidate set and
would have kept completion separate from JSX validation.

The type checker now retains the exact per-element props map it already builds
for component and intrinsic attribute validation. Attribute completion reads
that map, excludes attributes already present, and inserts `name={$1}` snippets.
The cursor-context scanner deliberately distinguishes top-level attribute names
from strings and expression containers so value completion remains on its
existing path. Regression coverage includes partial and empty prefixes,
previously supplied attributes, component props, and intrinsic props through
the same realistic Preact LSP session.

Contextual object-literal completion had a related call-only assumption: it
looked for an enclosing function/constructor argument before resolving object
members. A `style={{ ... }}` object therefore fell through to local-symbol
completion even though the type checker had already resolved Preact's
`CSSProperties`. Trying to reconstruct the shape from the displayed type text
(`CSSProperties?`) was insufficient because the declaration lives inside the
package's JSX namespace. The durable path was to retain the resolved contextual
property map produced by `expectedObjectProperties` and let the JSX-attribute
object-literal path consume it. Replacing the established call-argument path as
well initially changed optional-property hover from `T` to `T | undefined`; the
full suite exposed that regression, so call/new contexts continue through their
existing declaration resolver. The retained map also covers an otherwise empty
style object and avoids suggesting dynamic index signatures as literal property
names.

Empty JSX containers exposed a parser-recovery variant of the same symptom.
`prop={}` entered ordinary expression parsing at the closing brace, then the
outer recovery could blame or consume the following attribute. The JSX
container parser now recognizes the adjacent closing brace directly and
materializes an `UndefinedLiteral`. Parser, analysis, emitter, and realistic
LSP tests verify that `onAbort={}` becomes `onAbort: undefined`, produces no
spurious diagnostic, and leaves a following `style` attribute intact.

## Follow-up: closing component tags and existing style properties

A closing custom tag has no independent identifier or member-expression node
in the AST. Hovering `</CounterContext.Provider>` therefore selected the whole
JSX element and displayed `JSX.Element`, while go-to-definition found no bound
reference. Adding a second synthetic expression for the close would have
duplicated binding state. Instead, `Analysis` maps the closing tag character
back to the corresponding character of the opening tag, and the public hover
and definition entrypoints reuse their existing identifier/member navigation.
This also keeps dotted component names on the same semantic path as their
opening references.

Existing keys in `style={{ display: "flex" }}` already received contextual
hover from the retained property map, but definition could lose the named
`CSSProperties` owner after the checker expanded it to a structural type. When
the checked JSX context confirms that a key is valid and ordinary named-type
resolution cannot recover the declaration, definition now uses the existing
imported structural-member lookup. This is deliberately gated by the retained
contextual map so arbitrary object-literal keys do not acquire unrelated
definitions from dependencies. The realistic JSX LSP test now covers both the
dotted closing tag and navigation from an already-written style property.
