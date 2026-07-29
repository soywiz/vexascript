# Promise collection stress regressions

## Scope

Stress testing combined the checker, diagnostics, inlay hints, completion,
cross-file navigation, node-module typings, and every sample LSP session around
the standard Promise declarations.

## Confirmed failures

- `Promise.resolve("value").catch({ "fallback" })` was incorrectly diagnosed.
  The optional callback type was a union of a function, `undefined`, and `null`.
  Function assignability only applied its callback-arity rules when the expected
  type was already a bare function, so a valid zero-parameter callback was
  rejected.
- `Promise.all([Promise.resolve(1), Promise.resolve(2)])` inferred
  `Promise<T[]>` instead of `Promise<int[]>`. Generic inference did not bridge
  an array literal to the `Iterable<T | PromiseLike<T>>` parameter shape in the
  standard library declaration.

## Resolution

Function-call validation now extracts the sole callable branch only from an
optional union before comparing callbacks, preserving direct tuple-rest callback
signatures. Generic inference now obtains an iterable element type when the
parameter is `Iterable<T>`, then continues through the existing promise-like
inference path.

## Investigation note

Applying callable-union normalization to an already bare function changed the
representation of tuple-rest callbacks and caused diagnostics in the native
language sample. Restricting normalization to union-wrapped callback types keeps
the existing tuple-rest path intact.

## Follow-up collection and display regressions

Further adversarial probes found that the same standard declarations exposed
several independent weak boundaries:

- A TypeScript `this: Context` parameter inside a function-type annotation was
  treated as an ordinary callback argument. This shifted `flatMap` callback
  parameters and broke implicit `it` typing. It must be erased, not converted
  into a Vexa receiver parameter.
- Brace lambdas beginning with an array expression took the object-literal
  disambiguation route and lost their implicit `it` parameter.
- First-pass generic callback inference kept an `unknown`-shaped return type,
  causing a valid `flatMap` result to be rejected before final inference.
- The display layer rendered an array of a union as `A | B[]`, changing the
  apparent type in inlay hints.
- `Set<T>` was omitted from the common iterable and spread paths, leaving
  `Array.from`, all Promise collection combinators, and array spreads with
  unresolved element types.
- ES2025 set operations accepted `ReadonlySetLike<T>`, but both generic
  inference and assignability failed for ordinary `Set<T>` inputs.

The resolution keeps these at shared boundaries: the function-type parser
erases a leading TypeScript `this` parameter, brace-lambda fallback restores
the implicit parameter, contextual callbacks erase unresolved return shapes,
array displays parenthesize union elements, and `Set` participates in shared
iterable/spread extraction. `ReadonlySetLike<T>` is handled as the structural
collection contract it is, rather than by adding method-specific exceptions.

Regression tests cover checker diagnostics, collection result types, the
low-level iterable helper, parser type text, and the LSP inlay label for
`Promise.allSettled`.
