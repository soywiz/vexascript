# Native C++ ES2025 runtime parity

## Context

The embedded `compiler/runtime/es2025.d.ts` had gained the ES2023–ES2025
collection, buffer, string, promise, and regular-expression declarations while
the native emitter still rejected or mis-typed those calls.

## Investigation

The first implementation attempt placed `ArrayBuffer.transfer` inside the
buffer class and allocated the destination through `Runtime::make`. Generated
translation units include the runtime as one header, so that method was seen
before `Runtime` was complete. Moving the method definition below the runtime
factory fixed the incomplete-type error.

Generic `Map.groupBy` initially treated `optional<ArrayObject<T>*>` as a direct
pointer, and set algebra inferred a widened `Set<Value>` even when the native
receiver was `Set<int>`. Explicitly unwrapping grouped pointers and making set
algebra preserve the receiver's C++ element type fixed both issues.

Promise.try with a void callback also exposed a test-shape problem: placing a
void `nativeRunTask` call inside `console.log` made the emitter attempt to box
`void`. Keeping the settlement call as a standalone statement reflects the
actual runtime contract.

## Durable lesson

Ambient declaration additions need three checks: an emitter route, a concrete
native helper with the same generic shape, and a compile-and-run regression.
TypeScript's widened unions are not always the right C++ storage type; for
collection methods, the receiver's analyzed native type should remain the
canonical representation when the operation preserves element identity.

## Follow-up audit

The initial parity pass still had three declared ES2025 families without a
native route: `Float16Array`, iterator helpers, and `Intl.DurationFormat`.
Float16 storage uses IEEE-754 half conversion at the `ArrayBuffer` boundary;
iterator helpers consume a native iterator exactly once and box callback
values at callback boundaries; and `DurationFormat` provides the native
English/Spanish short, long, narrow, and digital subset together with parts
and resolved-options records. Growable shared-buffer declarations and regular
expression flag accessors were audited at the same time.

One iterator regression initially compiled but failed with “value is not a
string”. The generated filter lambda had an inferred `auto` parameter after a
map callback returned a boxed `Value`; C++ selected an incompatible conversion
path. The durable fix is to make unannotated iterator callback parameters
explicitly `Value` at the native boundary, while preserving explicit numeric
annotations. A temporary map-only source isolated the failure before the
full chained regression was restored.

The adjacent ES2024 audit also found `Atomics.waitAsync` had no native route.
The supported single-thread native path now covers integer views and preserves
the synchronous `{ async, value }` result shape used when the expected value
does not match.

The final Float16 audit found that implementing only the instance methods was
still incomplete: `Float16ArrayConstructor.of` and both practical `from` paths
(array-like sources and native iterator sources, with an indexed mapper) were
also declared by `es2025.d.ts`. The emitter now preserves the Float16 result
type for those static calls, and the native smoke test covers half-precision
rounding at the construction boundary.

The second `Atomics.waitAsync` overload was also real API surface rather than
just a declaration duplicate: it accepts `BigInt64Array` and `bigint`. A small
native BigInt64 view and overload now preserve that synchronous result contract
alongside the Int32 path, with one compile-and-run regression covering both.

## Native self-host regression investigation

The complete native smoke suite exposed two boundary mismatches that smaller
runtime tests did not cover. First, an array `sort` comparator was emitted with
the contextual callback shape `(element, index, array)`, although `sort` calls
its callback with two elements. The generated C++ consequently attempted to
use the second element as a numeric index. The emitter now gives `sort` and
`toSorted` the binary comparator shape `(left, right)`.

After that fix, dynamic native arrays still instantiated callbacks as
`ArrayObject<Value>` while the emitter preserved typed callback parameters for
some analyzed lambdas. A strict adapter that converted every `Value` to the
lambda's pointer type made the self-hosted CLI reject ordinary namespace values
such as `Intl`. Removing that strict conversion and making pointer conversion
null-safe at this dynamic boundary allowed the typed callback to remain
compatible without claiming that an unrelated runtime object has the expected
native type. The full `pnpm test:native` run now covers this path through the
self-hosted CLI bundle test.
