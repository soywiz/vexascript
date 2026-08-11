# Nullable generic type arguments need generic-close delimiters

## Context

The parser accepted the nullable suffix in declarations such as `value: T?`
and before arrays such as `T?[]`, but rejected it when the nullable type was
the final generic argument: `createContext<T?>(undefined)`. The optional-type
suffix parser decides whether `?` terminates a type by inspecting the following
token, and generic close tokens were absent from that delimiter list.

Nested generics make this boundary slightly less obvious because the tokenizer
can represent adjacent closes as `>>` or `>>>`. Supporting only `>` would fix
the direct call while leaving `createContext<Array<T?>>(undefined)` broken.

## Durable fix

Treat `>`, `>>`, and `>>>` as valid followers of a nullable type suffix in the
shared type-annotation suffix parser. This keeps nullable parsing on the same
path for declarations, type references, and explicit generic calls while
preserving conditional-type `?`, whose following token is the true branch
rather than a type delimiter.

No type-checker compatibility path was needed. Once the parser retained `T?`
inside the type-argument AST, the existing optional-suffix resolution already
interpreted it as `T | undefined`.
