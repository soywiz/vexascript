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

A follow-up exposed another split inside that dedicated path: an unannotated
computed generator method was correctly finalized as `AsyncGenerator<T>` from
its `yield` expressions and stored in the class scope, but protocol resolution
looked only at the method's syntactic return annotation. Consequently the same
method was typed precisely when called normally yet produced an `unknown` loop
variable through `[Symbol.asyncIterator]`. The protocol resolver now reuses the
already-analyzed class member symbol when the annotation is absent. This avoids
duplicating yield inference and keeps the method symbol as the durable source
of truth.

The next playground check revealed the inverse contract was also missing:
explicit generator element types influenced consumers but did not constrain
the generator body. `yield "text"` inside an `AsyncGenerator<int>` therefore
produced no diagnostic. Yield expressions are visited without a direct flow
argument, so the fix uses the existing active `FlowContext` rather than adding
a parallel generator-validation pass. Wrapper annotations extract their first
type argument, shorthand annotations act directly as the element type, and
`yield*` compares the delegated iterable's element instead of its container.
Diagnostics attach to the yielded expression, matching the editor-visible
source of the mismatch.

Delegated inference exposed a further ordering problem. An annotated stream
could contain `yield* mixedValues()` before the unannotated `mixedValues`
declaration, so the call expression was initially `unknown` and escaped the
check even though the later generator body yielded a string. Validating only
the already-computed call type was therefore insufficient. Yield contracts are
now finalized after ordinary statement analysis, and unannotated generator
dependencies are resolved by a bounded fixed point before those pending checks
run. `yield*` contributes the delegated element rather than the iterator
container itself. This also makes direct recursion and mutual cycles terminate
without recursive descent while propagating every known yield type around the
cycle. Regression tests preserve the forward-declaration case and both cycle
shapes.

The first yield-validation implementation called `.has()` directly on the two
static generator-name sets inside a compound condition. JavaScript tests
passed, but the native fixed point exposed a C++ emitter limitation: the static
set accessor produced a pointer and the chained call was emitted with `.`
instead of `->`. Assigning the async-or-sync catalog to a local variable looked
like the existing `finalizeFunctionReturnType` pattern, but a second fixed-point
run proved that the local `Set` receiver had the same bad lowering. The durable
fix removes those static sets and gives both yield validation and return-type
finalization one shared string-based `isGeneratorTypeName` predicate, avoiding
the unsupported native member-call shape entirely.

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
yield-derived inference for an unannotated computed generator method and its
actual LSP hover, direct and delegated yield mismatches against wrapper and
shorthand generator annotations,
full-pipeline `for await...of` emission, support for the standard
`AsyncIterable` type names, and the exact source range of a non-iterable loop
diagnostic.

## Execution metadata

- Provider: OpenAI
- Model: Unavailable (not exposed by runtime)
