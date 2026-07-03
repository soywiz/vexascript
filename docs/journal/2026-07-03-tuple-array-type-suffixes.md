# Tuple type array suffixes

## Context

The parser already preserved tuple-array type text such as
`[int, number, Animation][]`, but semantic resolution checked the broad
`startsWith("[") && endsWith("]")` tuple branch before stripping trailing array
suffixes. Since tuple-array text also ends in `]`, `[A, B][]` was sliced as a
single malformed tuple body and the final element became `B][`.

## What worked

Resolve array suffixes before tuple bodies in the TypeChecker paths that parse
loose type names, scoped type names, and computed type names. The shared
`splitArraySuffixTypeName` helper already returns the correct element text for
tuple arrays, so the durable fix is to route tuple-array forms through that
shared suffix path and then recursively resolve the tuple element type.

The binder now mirrors the same order for symbol types, so visible-symbol
metadata does not drift from semantic checking.

## Dead ends avoided

Changing the parser or adding a new AST node was unnecessary. The token stream
and stored annotation text were already correct; the bug was purely in the
order of semantic interpretation.
