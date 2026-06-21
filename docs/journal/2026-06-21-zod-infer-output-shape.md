# Zod Infer Output Shape

## What failed

The new `samples/zod/` coverage exposed a gap between two closely related type
paths:

- `type User = z.infer<typeof UserSchema>` could now be specialized to
  `{ name: string, age: number }`
- but `UserSchema.parse(...)` still returned Zod's internal mapped output shape
  with `unknown` property values

That mismatch produced both editor and compiler symptoms:

- hover on `user.name` collapsed to `any` or `unknown`
- `samples/zod/main.vx` reported assignment failures from `UserSchema.parse(...)`
  into the inferred `User` alias
- the broad sample harness and the focused imported-typing regression diverged

## Root cause

Zod's declaration strategy is layered:

- `z.infer<T>` expands through `T["_output"]`
- object schemas compute `_output` through mapped helper aliases
- the runtime `parse(...)` method is also meant to return that same output type

Our imported-typing engine could now synthesize the `_output` object shape from
the schema's `shape` member, but call resolution for `schema.parse(...)` still
trusted the ambient inherited method signature coming from Zod's internal helper
aliases.

That meant:

- type alias expansion and call return typing disagreed
- explicit `User` annotations became more specific than the `parse(...)` call
  result

## What did not help

- Broadening mapped-type handling globally. Several attempts made generic
  imported utility cases regress (`Partial`, readonly mapped types, Pixi/Three
  option shapes) while still not fixing the real Zod path.
- Re-parsing deferred indexed-access names after textual substitution. That was
  too fragile and introduced unrelated regressions.
- Widening generic parent-interface handling globally. That touched too many
  ecosystem cases for too little direct signal.

## What helped

The stable fix was narrow and aligned the two Zod-facing paths instead of trying
to fully model every internal helper alias:

- keep the localized `_output` synthesis for schema-like types with a `shape`
  member
- when resolving a `schema.parse(...)` call, prefer that same synthesized output
  type as the call return type

That made both of these agree again:

- `z.infer<typeof UserSchema>`
- `UserSchema.parse(...)`

## Final outcome

The repository is now green again with the Zod sample included:

- focused imported-typing regressions pass
- `samples/zod/` passes in the compile/runtime harness
- full `pnpm test` passes

The useful lesson is that ecosystem libraries sometimes need a small
compatibility bridge at the API surface even when their internal declaration
machinery is much more complex than we want to model wholesale.
