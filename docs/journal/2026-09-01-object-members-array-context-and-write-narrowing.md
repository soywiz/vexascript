# Object members, generic array context, and write narrowing

## Symptoms

A real VexaScript game exposed three false diagnostics that isolated snippets
had not covered:

- `this.constructor.name` reported that a class instance had no `constructor`;
- `private readonly callbacks: Array<() => void> = []` rejected the empty array
  as `unknown[]`;
- assigning a declared `GameObject` to `this.gameObject` after a guarding
  `if (this.gameObject) throw ...` compared the value against the read-narrowed
  type `never`.

## Causes and fixes

Class member resolution collected declared and inherited class members but did
not expose the JavaScript `constructor` property. Named-object member lookup now
resolves `constructor` as `Function` without adding it to the structural member
map, where it would incorrectly become a required property during structural
assignment. The LSP class-member model uses the same `Function` type so chained
completion offers `name`, `length`, and function methods.

Array contextual typing recognized internal `T[]` representations but not the
equivalent named `Array<T>` and `ReadonlyArray<T>` forms. The shared expected
element lookup and array assignability paths now handle both spellings. Empty
array literals retain the contextual element type instead of falling back to
`unknown` when such a type is available.

Pure assignment targets were incorrectly passed through expression read
narrowing. The type checker now skips narrowed-expression substitution for a
member used only as the left side of `=`, while preserving narrowing for reads
and compound assignments.

## Integration sample

The new `samples/box2d` project uses `@box2d/core` 0.10.0, matching the platform
game. It creates a static floor and dynamic box, steps the simulation to a
deterministic resting position, and simultaneously exercises primary-constructor
modifiers, `this.constructor.name`, and an empty `Array<() => void>` field.

## Validation lesson

A full project CLI build can spend substantial time loading and checking large
third-party declaration graphs without emitting progress. Opening the exact
files through the LSP session harness gave a faster, faithful validation of the
reported editor diagnostics. Both original game files completed with zero error
diagnostics after the fixes, while the Box2D sample preserved broader package
loading and bundle coverage.

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: Unavailable (not exposed by runtime)
