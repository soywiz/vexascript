# Native ambient type contract regression

## Symptom

The last green native Actions run was Tests #397, commit `a72c7115` (“Run
Linux native tests in parallel”). The subsequent ambient-name and runtime
dispatch refactors caused the native suite to fail. Runtime-backed declarations
were emitted using a mechanical `NameObject<...>*` spelling even when their
native contracts were different, and collection calls stopped using the
runtime's iterator and `undefined` semantics. The failures included
`Float16ArrayObject<T>`, `DataView<T>`, `ReadonlySetLikeObject<T>`, and
`MapIteratorObject<T>`.

## Investigation

The first failure reported by the native CLI test was a rejected `for...of`
over `MapIteratorObject<vexa::Value>*`. The same mapping change also explained
the independent C++ parser errors in the foreign-library and typed-array tests:
the runtime declares non-generic typed-array and DataView classes, while the
ambient TypeScript declarations have generic buffer parameters. The native
runtime represents `ReadonlySetLike<T>` with the existing `SetObject<T>`
implementation because the set operation methods accept that concrete pointer.

An attempted broad generic ambient heuristic was a dead end: it removed the
invalid generic names but produced 182 secondary diagnostics because unrelated
ambient declarations were mapped to native objects without an actual runtime
contract. That branch was reverted in favor of explicit mappings only for
runtime-backed names, with a structural fallback for declarations that really
have a matching native object contract.

## Fix and regression prevention

The unified ambient mapper now keeps the runtime's explicit contracts for
arrays, collections, weak collections, iterators, promises, errors, buffers,
typed arrays, and other native objects. The emitter restores native collection
methods and preserves `undefined` for missing `Map.get`/`WeakMap.get` values;
nullish coalescing and optional collection calls are covered by focused emitter
assertions and the complete native sample. The agent instructions also make
the complete native sample smoke a mandatory pre-commit and pre-push gate,
with `pnpm test:native` required before closing native/compiler work.
