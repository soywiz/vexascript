# Primary-constructor property modifiers

## Problem

VexaScript primary constructors already promoted every parameter to an instance
property, but their AST node retained only the declaration kind. Consequently,
the Kotlin-style form could not express the access and readonly metadata already
supported by TypeScript constructor parameter properties and ordinary class
fields.

## Resolution

- Primary-constructor properties accept `public`, `protected`, or `private`,
  followed by optional `readonly`, before `let`, `var`, `val`, or `const`.
- The primary-constructor AST node is the single source of that metadata for
  semantic visibility checks, readonly assignment checks, formatting, semantic
  highlighting, and JavaScript emission.
- Runtime lowering continues to erase type-level modifiers and initializes the
  same instance properties as before.
- `val` and `const` remain inherently readonly. Explicit `readonly` is accepted
  with them for TypeScript-style clarity, and also makes `let` or `var`
  properties readonly.

## Regression coverage

Tests cover parsing all access levels, canonical formatting, modifier erasure,
semantic highlighting, private/protected access, subclass access, and readonly
assignment diagnostics both inside and outside the declaring class.

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: Unavailable (not exposed by runtime)
