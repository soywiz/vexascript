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

## Awaited values and return-type actions

Additional probes found a second family of bugs around values that are already
awaitable:

- Static `Promise.resolve`, `all`, `race`, `any`, and `allSettled` did not
  consistently apply recursive `Awaited<T>` when their generic overload fell
  back to the iterable declaration. Declared nested promises were therefore
  displayed as `Promise<Promise<T>>` after a single combinator call.
- Pervasive auto-await inside `sync` functions only removed one `Promise`
  layer and did not recognize `PromiseLike<T>`. The checker and the inlay
  display could consequently disagree about the visible local type.
- The "add explicit return type" action wrapped an already promised return
  value from an `async` function, generating `Promise<Promise<T>>`. It also
  refused to offer a fix when return statements had different compatible
  types, despite a union being a valid annotation.
- Conditional expressions with unrelated branch types were inferred as
  `unknown`, which hid the second return type from the action and weakened
  normal diagnostics.

The checker now uses its recursive awaited-type operation for implicit awaits,
the LSP presentation follows the same recursive Promise/PromiseLike rule, and
the return-type utility builds a deduplicated top-level union. Conditional
expressions retain the nearest common assignable type when one exists and use
a union otherwise. A discarded investigation tried to broaden generic
substitution merging globally for tuple Promise calls; it changed unrelated
Promise constructor inference, so the change was reverted rather than leaving
a broad compatibility regression.

A follow-up async quick-fix probe showed that `Awaited` must distribute over a
top-level union: returning either `Promise<int>` or `int` from an `async`
function should produce `Promise<int>`, not `Promise<Promise<int> | int>`.
The return-type action now splits only top-level union members before applying
the same recursive Promise/PromiseLike unwrapping. The shared return collector
also powers inlay return hints, so a function with `int` and `string` returns
now receives the useful `: int | string` hint instead of no hint.

The auto-await detector originally recognized only a direct `Promise` or
`PromiseLike` named type. A call returning `Promise<int> | Promise<string>`
therefore escaped auto-await in a `sync` function. It now compares the shared
recursive awaited result to the original type, which also covers unions without
adding a second Promise-shape classifier.

Typed Promise tuples exposed a related generic boundary: the iterable overload
had to infer `T` from `Iterable<T | PromiseLike<T>>`, accept tuple elements as
iterable values, and recognize `Promise<T>` as assignable to `PromiseLike<T>`.
Keeping those rules in generic inference and assignability restores
`Promise.all([Promise<int>, Promise<string>])` as `Promise<[int, string]>`
without a Promise-specific diagnostic exception.

The same positional preservation applies to `Promise.allSettled`: a typed
tuple must produce a tuple of independently awaited settled-result unions,
not one array whose fulfilled member contains the union of every position.

Strings are both `Iterable<string>` and `ArrayLike<string>` in the standard
library. The shared collection path had modeled neither relation, so
`Array.from("Ada")` selected an overload but rejected its argument. Element
extraction, generic inference, and assignability now agree on this primitive
collection contract.

The iterable overload is independently exercised by `Promise.all("Ada")`.
Accepting strings as `ArrayLike` was insufficient until assignability also
recognized `string` as `Iterable<string>`.

Typed arrays encode their element type in their nominal class name rather than
as a collection type argument. A single shared map now lets `ArrayLike<T>` and
iterable consumers infer `number` or `bigint` from all standard TypedArray
classes, covering `Array.from(new Uint8Array(...))` without API-specific logic.

Boxed strings are a distinct nominal `String` type even though their iterator
yields primitive strings. Treating only the primitive `string` as iterable left
`Array.from(new String("Ada"))` as unresolved `T[]`. The shared element helper
now normalizes that standard boxed collection contract to `string`, so every
consumer that already relies on the helper receives the same result.

Generic interface constructors had drifted from ordinary generic calls. Their
first contextual pass was followed by a separate manual inference path, which
missed tuple arguments and left `new Map([["name", 1]])` as `Map<K, V>`. A
tuple is assignable to an array, so generic inference now follows that same
relation and inspects each tuple element for an array parameter. Non-Promise
interface constructors then use the standard function-instantiation path after
contextualizing their arguments. This preserves `Map<string, int>` and its
iterable entry type through `Array.from` without a Map-specific special case.

Tuple-to-array inference still retained its first candidate when later tuple
elements were unrelated. Consequently a heterogeneous Map entry list inferred
`K = int` from its first entry and rejected a later `string` key. That specific
covariant collection path now forms a deduplicated union from its independent
element substitutions. Applying the rule to all generic evidence was ruled out:
it incorrectly mixed a contextual expected Promise type with an executor's
actual type, weakening a useful incompatibility diagnostic.

Plain heterogeneous array literals intentionally widened to `any[]`, but this
also made `new Set([1, "two"])` infer `Set<any>`. The constructor's
`Iterable<T>` parameter now gives an array literal an `Array<T>` context; while
that element target remains an unresolved generic, the literal keeps its
incompatible element candidates as a union for inference. A first attempt to
make every array literal use unions broke existing tuple-based constructor
inference, so the preservation is deliberately limited to this contextual
generic collection path.

`Promise.all` has a static result-type specialization which was still reading
the widened array argument directly. A heterogeneous literal therefore became
`Promise<any[]>` even after collection inference improved. That specialization
now reads the literal's structural element types solely to derive its awaited
element union, while retaining TypeScript's ordinary array result for an
unannotated literal and reserving tuple results for an already typed tuple.
