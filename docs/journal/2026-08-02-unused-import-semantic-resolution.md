# Unused-import diagnostics for semantic extension usage

## Context

The Monaco playground reported `drawCard`, `operator+`, and `operator/` as
unused even though the first was called inside an optional receiver block and
the operators were selected by infix expressions. The runtime output was
correct; only the unused-import hint was wrong.

## Root cause

Unused-import analysis originally recognized direct identifier resolutions and
then treated every matching member-property spelling as usage. Receiver-block
extension methods are represented by synthetic implicit-receiver symbols whose
node is the receiver block, while imported operator overloads and extension
properties are represented by their own semantic resolution records. None of
those records necessarily points at the identifier node in the import clause.

The playground session fixture had also drifted from the real embedded source:
it still used cascade calls and simplified extension declarations. That fixture
did not exercise the failing syntax or produce the same operator/property
resolution metadata as the live playground.

## Fix and architectural lesson

The analysis result now relates resolved extension-method names, operator
symbols, and extension-property declarations back to the canonical imported
symbol records. This replaces the broad property-spelling shortcut with one
semantic path for direct imports and extension features. The playground test
uses the real optional receiver-block shape and the same cross-file diagnostic
entrypoint as Monaco.

When an editor-only import diagnostic disagrees with successful compilation,
test the fully collected cross-file session. A bare parser or single-file
analysis session omits the declaration origins and extension metadata needed to
reproduce the editor result.

## Investigation dead end

Matching only `declarationOrigin.statement` against resolved symbol nodes fixed
ordinary explicit extension calls but not receiver-block calls. Those calls are
intentionally anchored to a synthetic receiver symbol. Exported semantic names
must therefore be considered alongside declaration identity.

## Regression risks

- Explicit and implicit receiver extension calls must both count as import use.
- Operator imports must be marked used only through resolved operator metadata.
- Extension-property imports must use their resolved declaration or exported
  name, not an unrelated member access with the same spelling.
- Monaco fixtures must stay synchronized with syntax used by the embedded
  playground when they are intended to cover its full workspace path.
