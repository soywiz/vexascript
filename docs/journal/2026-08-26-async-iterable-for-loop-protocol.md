# Async iterable loop protocol resolution

## Summary

A class that declared `async *[Symbol.asyncIterator](): AsyncGenerator<T>` was
valid at runtime but a declaration-free VexaScript `for-of` loop emitted a
synchronous JavaScript `for-of`. The browser then failed with `TypeError: value
is not iterable`. The same loop also inferred its iterator variable as
`unknown`, and genuinely non-iterable loop sources produced no semantic
diagnostic.

The checker previously classified iteration only from a small catalog of direct
type names such as `AsyncGenerator` and `AsyncIterator`. It did not inspect the
well-known symbol protocols declared by a user class or interface. Iteration
resolution now has one type-driven path that returns the element type and
whether JavaScript emission must use `for await...of`. It follows generic
substitutions and inherited class/interface declarations for
`Symbol.iterator` and `Symbol.asyncIterator`. A failed `for-of` resolution
reports the diagnostic on the source expression in the loop header, while
`for-in` object-key enumeration remains a separate language behavior.

## Investigation and rejected approach

The first implementation admitted the two well-known computed methods into the
general named-member map. That made the async stream regression pass, but it
also changed structural assignability for standard `Set`, `Map`, boxed strings,
typed arrays, and `Array.from`/`Promise` overloads. Focused analysis tests
reported eleven unrelated failures. This showed that computed symbol members
had intentionally been excluded from the string-keyed member model and should
not be exposed globally.

The final implementation leaves general member resolution unchanged and reads
only the two iteration protocol declarations while resolving a loop. This keeps
protocol knowledge type-driven without contaminating string-property
completion or structural assignability.

A second attempted refinement inferred `T` from the first generic argument of
every custom iterator return type. That made standard `MapIterator` and
`ArrayIterator` element types more precise, but it also changed the compiler's
own native analysis enough to expose an unsupported `Value`-to-pointer cast in
the C++ fixed point. The loop resolver therefore treats an unrecognized
protocol return as a valid iterable with an `unknown` element. Known declarations
such as `Iterator<T>` and `AsyncGenerator<T>` still preserve `T`; arbitrary
generic names are not interpreted by position alone.

## Regression protection

Tests now cover element-type inference from a class async-iterator protocol,
full-pipeline `for await...of` emission, support for the standard
`AsyncIterable` type names, and the exact source range of a non-iterable loop
diagnostic.

## Execution metadata

- Provider: OpenAI
- Model: Unavailable (not exposed by runtime)
