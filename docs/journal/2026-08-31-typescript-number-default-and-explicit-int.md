# TypeScript-default numbers and explicit `int`

## Problem

VexaScript historically inferred integer-looking literals as `int`. That made
ordinary JavaScript expressions context-sensitive: `1 / 60` could be lowered
to zero when an `int` result was expected, and standard properties such as
`Array.length` leaked a VexaScript-only type into the ES2025 declarations.
Fixing only division avoided one browser hang but left the underlying numeric
model different from TypeScript.

## Resolution

- Every unsuffixed numeric literal is now `number`, including hexadecimal,
  binary, octal, decimal, and scientific spellings.
- `i` is the only integer-literal suffix and produces a signed 32-bit `int`.
- `int(value)` is the explicit conversion intrinsic and emits `value | 0`.
- `number` literals and expressions never convert implicitly to `int`, even
  when a literal's value is mathematically integral.
- `/` always has JavaScript fractional semantics. `\` performs explicit integer
  division, emits `(left / right) | 0`, and returns `int`.
- Standard `length` properties and timer identifiers use `number`, matching the
  TypeScript ES declarations.

VexaScript enums still require explicit `int` or string initializers, while
TypeScript-source enums accept ordinary `number` initializers. Samples and test
fixtures were migrated according to intent: indexing, counts, and normal
JavaScript arithmetic use `number`; FFI layouts and tests specifically about
32-bit integers use `i` or `int(...)`.

## Investigation lessons

Removing contextual conversion only from integer-shaped AST nodes was
insufficient. Decimal literals such as `10.0` still flowed through a shared
contextual-literal helper and silently became `int`; strict-conversion tests
must cover both integer-looking and decimal spellings.

Running a single-file CLI build on a multi-file sample produced unrelated
`unknown` diagnostics because it lacked the sample project's import context.
The all-samples LSP and execution harnesses were the authoritative validation
paths. A full test run inside the restricted sandbox also made CLI serve tests
fail with `listen EPERM`; running the final suite with localhost permissions
distinguished infrastructure restrictions from compiler regressions.

The broad test migration was useful evidence rather than noise. Expectations
that merely displayed inferred values changed from `int` to `number`, while
fixtures with explicit `int` APIs had to opt in using `i`. Treating every
failure as one category would either preserve stale expectations or conceal
real missing conversions.

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: Unavailable (not exposed by runtime)
