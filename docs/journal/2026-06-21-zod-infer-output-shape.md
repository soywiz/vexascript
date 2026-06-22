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

## 2026-06-22 follow-up: real helper aliases still matter

Expanding the runnable Zod sample with `z.array(z.string())` and `z.boolean()`
showed that the earlier bridge was not enough. The real package declarations
still broke in two reusable ways:

- tuple-rest type aliases such as
  `Cardinality extends "atleastone" ? [T["_output"], ...T["_output"][]] : ...`
  were skipped by the parser;
- generic parent types were resolved before class type parameters were
  substituted, so `ZodArray<T>` inherited `_output` as `unknown[]` instead of
  `string[]`;
- mapped helper aliases such as `{ [K in keyof T]: ... }[keyof T]`,
  `requiredKeys<T>`, and `optionalKeys<T>` needed generic evaluation rather
  than a Zod-specific special case.

What worked this time was to fix those shared pieces:

- parse tuple rest elements in type annotation text;
- only defer top-level conditional types, not conditionals nested inside generic
  arguments;
- substitute generic parameters into inherited type text before resolving type
  aliases;
- evaluate indexed mapped helper aliases and conditional mapped property values.

The sample now keeps real user-facing coverage for `settings.tags[0]` as
`string` and `settings.active` as `boolean`, while the focused
`node_modules` regression keeps hover on `settings.tags` at `string[]`.

## 2026-06-22 follow-up: enum builders expose indirect constraints

Adding `z.enum(["admin", "user"])` to the same sample exposed another reusable
declaration pattern from real library typings:

- exported namespace members can be declared as `declare const enumType: typeof
  createZodEnum`, so `typeof function` type queries must produce callable
  imported values;
- enum builders constrain one type parameter through another,
  `T extends readonly [U, ...U[]]`, so validating `T = string[]` must treat
  the still-unresolved `U` as an active type parameter inside that constraint;
- the parser currently represents rest tuples as ordinary tuple elements, so
  assignability needs to recognize the collapsed `[U, U[]]` shape when an array
  is checked against a rest-tuple constraint.

The fix kept this in the shared type system instead of a Zod-only branch:

- imported declaration resolution now resolves `typeof` queries against
  function declarations, preserving callable namespace members;
- function type-argument constraint validation now runs inside the generic
  function's active type-parameter scope;
- array-to-tuple assignability accepts collapsed rest-tuple constraints while
  keeping readonly direction checks.

The focused regression covers the `typeof createZodEnum` and
`readonly [U, ...U[]]` path, while `samples/zod` now exercises
`z.infer<typeof RoleSchema>` at runtime by printing `ADMIN`.

## 2026-06-22 follow-up: readonly tuple text can lose whitespace

Extending the sample with `z.union([z.literal("admin"), z.literal("user")])`
exposed a smaller but reusable parser/typing mismatch. Zod's union builder uses
a minimum-length variadic tuple constraint:

- `T extends readonly [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]`

In one declaration path the type annotation text reached analysis as
`readonly[ZodTypeAny,ZodTypeAny,...ZodTypeAny[]]`, without the whitespace after
`readonly`. Our readonly container parser only accepted `readonly [...]`, so the
constraint stayed as an opaque named type and the array-to-rest-tuple
assignability path never ran.

The fix was to make `parseReadonlyContainerTypeText` accept both spellings:

- `readonly [A, B, ...Rest[]]`
- `readonly[A, B, ...Rest[]]`

The focused test now covers the whitespace-free form directly, the imported
Zod regression covers `z.union`, and `samples/zod` keeps runtime coverage for
the union plus a defaulted object property.
