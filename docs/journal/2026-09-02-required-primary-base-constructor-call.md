# Required primary base-constructor calls

## Problem

Base-constructor arguments were validated only when the heritage clause
already contained parentheses. `class Child(value: int) extends Base` could
therefore bypass a required `Base(value)` call. The parser also discarded an
explicitly empty primary constructor list, preventing `class Child()` from
participating in primary-constructor checks.

## Change

The parser preserves empty primary constructor lists. For every class with a
primary constructor and a base class, semantic analysis now validates the
heritage clause as a constructor call, using an empty argument list when no
parentheses were written. Existing call validation remains the single source
of truth for required, optional, defaulted, rest, and incompatible arguments.

## Regression risk

Do not special-case only non-empty primary constructors or only heritage
clauses that already contain arguments. Either shortcut recreates the bypass.
Conversely, classes without a primary constructor retain their existing
explicit-constructor and JavaScript-compatible inheritance behavior.

## Verification

- Parser coverage distinguishes `class Child()` from `class Child`.
- Analysis coverage rejects omitted required base arguments, accepts explicit
  forwarding, and accepts omission when all base parameters are defaulted.

## Execution metadata

- Date: 2026-09-02
- Provider: OpenAI
- Model: Unavailable (not exposed by runtime)
