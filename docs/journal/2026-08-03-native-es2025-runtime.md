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

## Declaration-driven array calls

The follow-up refactor removed the duplicated array callback table from the
emitter. The emitter now converts the analyzed ambient callback type into the
native `std::function` signature, including its parameter list and inferred
return boundary. `ArrayObject<T>` exposes the corresponding member names, so
generated code calls `receiver->map(...)`, `receiver->filter(...)`, and the
other array methods directly. This keeps the declarations and the C++ class
contract aligned; correcting a callback parameter in the ambient surface no
longer requires a second method-name branch in the emitter.

## Container representation follow-up

The remaining architectural concern is deeper than method spelling. JavaScript
arrays, maps, and sets are heterogeneous at runtime, while the native runtime
currently exposes `ArrayObject<T>`, `MapObject<K, V>`, and `SetObject<T>` as if
their C++ template arguments were the JavaScript container contract. Those
templates can remain useful for proven native storage, but they should not be
the ambient-facing representation. The planned direction is a `Value`-backed
JavaScript container boundary with optional typed storage behind it, applied to
maps and weak collections as well as arrays.

The implementation work and acceptance checks are tracked in
`docs/tasks/decouple-native-ambient-runtime-contract.md`. This distinction is
important because simply deleting emitter `if` branches without separating the
container boundary would replace one coupling with another: generated C++
would still depend on template-specific storage decisions.

The first static-family slice now follows that plan for `Object`: the emitter
uses one ambient static-call route, while `native/runtime.cpp` exposes
`ambient::Object::keys`, `values`, `entries`, `fromEntries`, `groupBy`, and
`defineProperty`. The old per-method lowering branches are gone. The runtime
wrapper still owns descriptor semantics, so the emitter no longer needs to
inspect `Object.defineProperty` descriptors or choose `recordKeys` versus
`recordValues` itself.

The same slice now covers `Map.groupBy`: generated code uses
`ambient::Map::groupBy`, and the runtime wrapper forwards to the existing typed
or `Value`-backed implementation. The remaining `MapObject<K, V>` storage is
intentionally not being mistaken for the JavaScript-facing contract; its
heterogeneous `Value` boundary, object-key behavior, and callback lifetime are
tracked in `docs/tasks/decouple-native-ambient-runtime-contract.md`.

The static route is now declaration-driven rather than a growing list of
receiver/method tests. The C++ emitter collects ambient global values from the
runtime declarations (including nested `declare global` blocks) and emits
`vexa::ambient::<global>::<member>` for ordinary static calls. Runtime wrappers
cover `Math`, `Number`, `Array`, `String`, `Date`, `JSON`, `RegExp`, `Iterator`,
`Atomics`, `Float16Array`, `performance`, `Object`, `Map`, and `Promise`.
`Intl.DurationFormat` remains a contextual object lowering because its native
result object and duration normalization are not a plain forwarding call.

Promise static calls now use the same ambient route. The result type inferred
from the declarations supplies template arguments only where C++ cannot
deduce them, such as `withResolvers` and `reject`; combinators use a generic
task-array adapter that accepts both `Task<T>` and already-resolved values.
An initial generic adapter exposed a concrete `ArrayObject<RecordObject*>`
result from `allSettled` where the surrounding dynamic contract expected
`ArrayObject<Value>`. Converting those records at the runtime boundary fixed
that mismatch without adding a Promise-method branch back to the emitter.

The same audit found that `Math.PI` and numeric `**` were still bypassing the
ambient namespace even though ordinary `Math` calls already used it. The
runtime now exposes Math constants and `pow` through `ambient::Math`, and the
emitter routes both property access and exponentiation through that contract.
This leaves the remaining name-sensitive branches limited to platform objects,
contextual object lowerings, binary accessors, and syntax-driven lowering;
the Map/WeakMap representation and callback-GC work remain explicit follow-up
tasks in the decoupling task document.

The Promise continuation audit then removed the last ordinary emitter branch
that selected `promiseThen`, `promiseCatch`, or `promiseFinally` by method name.
`Task<T>` now exposes the ambient operations directly (`then`, `vexa_catch`,
and `finally`; `catch` is escaped by the generic C++ name mangler), while the
emitter recognizes only the native `Task` receiver type and forwards the
declared member name. Callback result context is supplied from the resulting
`Task` type, so typed chains remain strongly typed without a Promise-specific
name table. The complete native language smoke still has its pre-existing
self-host/language failures, but its generated Promise errors disappeared.

## Direct contracts for the remaining ES2025 slice

The next audit removed three more ordinary method mappings. `TextEncoder` now
has a managed native object whose `encode` and `encodeInto` methods are called
by their declared names. The constructor still has a representation-specific
lowering because the runtime object is managed, but it is not a method-name
translation. A native module-isolation regression initially mangled the
constructor identifier, so the emitter also recognizes the original ambient
name metadata; this is constructor identity handling, not an `encode` mapping.

Growable `ArrayBuffer` methods now call `resize`, `grow`, `transfer`, and
`transferToFixedLength` directly on the native object. The runtime keeps
byte-oriented helpers private (`resizeBytes`, `growBytes`, and
`transferBytes`) and exposes the ambient signatures at the object boundary.
Generators follow the same rule: `BasicGenerator` exposes `vexa_return`, the
generic C++ name mangler maps the ambient `return` member to it, and the emitter
forwards generator members without selecting `.finish()` by method name.

`Intl.DurationFormat` instance methods and the nested static
`supportedLocalesOf` operation now use the declaration-driven path. Reaching
the nested static declaration exposed two infrastructure gaps: transpile
analysis was not receiving the embedded ECMAScript declarations, and nested
ambient namespace values could become `unknown`. Transpile now includes the
embedded declarations, the emitter treats declared namespaces as ambient
static roots, and uniquely qualified nested type names are resolved when the
name is unambiguous. A separate existing limitation remains visible in the
native-facing sample: VexaScript object literals currently need a literal type
assertion for `DurationFormat` option unions because contextual literal
inference is not preserved through interface constructor signatures.

The map decision remains intentionally separate. The current declaration-driven
call path is sufficient for `Map.get`, `set`, `has`, `delete`, `keys`, and
`groupBy`, but typed `MapObject<K, V>` storage is still the wrong JavaScript
boundary for heterogeneous keys and values. The concrete Value-backed Map,
WeakMap, Set, and WeakSet boundary, object-identity tests, varying callback-key
tests, and callback GC lifetime tests remain documented follow-up tasks in
`docs/tasks/decouple-native-ambient-runtime-contract.md`.

## Declaration-driven native type names

The remaining type mapper was still recognizing `URL`, iterator families,
errors, collections, buffers, and typed arrays through emitter-side name
branches. That was the same coupling problem as the retired method tables:
adding a new ambient object required modifying `cppEmitter.ts` even when its
C++ representation followed the obvious `vexa::<Name>Object` convention.

The native declaration contract now owns this information. Ambient class and
interface names derive their managed pointer spelling from the declaration
itself: `Thing` becomes `vexa::ThingObject*`, with generic arguments preserved.
The emitter collects these ambient names from embedded Vexa declarations and
the selected ambient/external declarations, and uses the same convention for
analyzed and textual types. A regression with a new `declare class URLLike`
proves that it emits `vexa::URLLikeObject*` without adding `URLLike` to the
emitter. Generated TypeScript declaration files remain unchanged; the
convention is compiler-side structural knowledge rather than source
annotations.
