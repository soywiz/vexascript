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
