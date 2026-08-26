# Native runtime template erasure

## Context

The split native runtime still instantiated separate C++ collection classes for
every VexaScript `Map<K, V>`, `Set<T>`, `WeakMap<K, V>`, and `WeakSet<T>`. It
also stored ordinary arrays according to the C++ type selected at their creation
site. Besides increasing generated-code parsing and template instantiation work,
the array representation violated JavaScript aliasing: passing `MyType[]` as
`any[]` could not accept a value outside `MyType`, even though both references
must point at the same mutable JavaScript array.

## Resolution

Map, Set, WeakMap, and WeakSet now have one concrete runtime class each. Their
keys and values use `Value`/`StoredValue`; source generic arguments remain solely
in semantic analysis and guide conversions at generated-code boundaries.
Collection construction and ordinary calls are direct, non-templated runtime
calls. `forEach` uses one concrete Value callback contract, with generated
adapters converting arguments to the callback's semantic parameter types.

`ArrayObject<T>` remains a typed native view because internal arrays can contain
non-ECMAScript values such as `Task<T>`. For every ECMAScript-representable T,
however, its physical slots are now `StoredValue`. A typed array and an `any[]`
view therefore share one layout and identity, and mutation through the dynamic
view no longer attempts to coerce the inserted value back to the creation-site
type. Explicit `MyType[]`-to-`any[]` smoke coverage is intentionally deferred to
the follow-up that removes `ArrayObject<T>` itself, so this intermediate phase
does not claim the final erased-array contract prematurely.

The deterministic header count fell from 529 lines beginning with `template`
to 372. Map/Set/weak-collection class templates and the large family of
key/value-specialized collection algorithms were removed entirely. Remaining
templates primarily implement typed array algorithms, promises/tasks,
generated-language generics, callbacks, and native conversion boundaries.

## Investigation notes

The first Value-backed collection build exposed several assumptions that unit
emitter assertions did not detect:

- `Map.get` was initially converted immediately to its declared primitive type,
  which turned a missing entry into a numeric-conversion error instead of
  preserving `undefined`.
- Collection `forEach` initially passed raw `Value` objects to typed generated
  lambdas. Concrete callback adapters are required now that the collection class
  no longer carries K/V/T as C++ template arguments.
- Weak collection validation used `Value::isRuntimeObject()`, which excludes
  object-literal records. ECMAScript weak keys accept records and other objects,
  but must still reject the internally boxed string representation.
- Erasing C++ Map arguments revealed that inferred top-level collection
  declarations did not retain their source generic names. Optional nested Map
  access therefore followed the dynamic path. Map's dynamic `get` surface was
  implemented as a rooted callable so dynamic and optional access remains
  correct while semantic collection metadata is improved independently.
- The first self-hosted run failed by casting an array of string tuples to an
  interface-property pointer. The analyzed `flatMap` result had inherited the
  receiver element type, and that contextual type then rewrote the callback's
  conditional tuple arrays. Inferring expression- and block-bodied array
  results from the callback syntax before applying semantic fallback removed
  the invalid cast and protects other erased-array views from the same failure.
- The complete smoke then found a callback-parameter inference gap in
  `numbers.map(...).filter(...)`: the shorthand `map` callback was inspected
  before its `it` parameter had received the array element type, so arithmetic
  fell back to `Value`. Propagating `filter`'s final result type backward looked
  attractive and fixed that smoke, but broke the self-hosted compiler's real
  `map(parameterBindingName).filter(name !== null)` path by coercing the
  intermediate `null` to string too early. The durable fix infers `map` callback
  results with receiver-derived parameter types while leaving the callback's
  output unconstrained. Focused regressions cover both the numeric shorthand and
  nullable intermediate cases; the executable smoke and self-hosted bundle
  remain the authoritative behavioral checks.

An early cache version copied the complete runtime source tree and the Oilpan
and mimalloc ZIP files into every runtime fingerprint directory, then retained
all individual object files and a precompiled header. That duplicated independent
dependencies and made content-addressed variants grow without bound. The final
design reads runtime files as raw bytes, builds objects in temporary storage,
deletes them after `ar` succeeds, and retains only the runtime `.a` archive and
its compatible Clang PCH.

An O0 CLI link with a warm runtime archive took about 19 seconds on this machine;
compiler generation itself took about 4.7 seconds. These wall-clock figures are
observations rather than pass/fail thresholds. Earlier smoke measurements that
used a different runtime layout are not directly comparable to the final cache design.

After the callback and covariance fixes, native self-compilation measurements
ranged from about 190.2 to 241.4 seconds on this machine. The final full
TypeScript test suite completed 2,924 tests in about 66.5 seconds. These numbers
include very different workloads and are recorded for diagnosis, not as a direct
performance ratio or a timing assertion.

With the final `.a` plus PCH cache layout, a focused cold-fingerprint build and
execution of the complete native-language smoke completed in about 30.2 seconds.
The resulting fingerprint contributed exactly one static archive and one Clang
PCH to the runtime cache; no copied source tree, dependency archive, or object
file was retained. With those artifacts warm, the final full native run compiled,
linked, and executed the main smoke in about 4.36 seconds and completed all 55
native tests in about 489.5 seconds; most of that total was the two native CLI
self-hosted workloads.

The final fixed-point run measured compiler generation separately from native
toolchain work. The JavaScript-hosted compiler generated the complete C++ CLI in
4.84 seconds; the `clang++ -O1` native compiler generated it in 13.62 and 13.70
seconds, roughly 2.8 times the JavaScript-hosted generation time. Native
dependency preparation took 32.88 seconds, and the complete native fixed-point
stage took 264.37 seconds because it also compiled and linked the large generated
CLI and ran two native generations. A representative warm-PCH `-O0` CLI link
took about 18.4 seconds. These separate measurements avoid attributing native
compiler execution time to the C++ linker or runtime parsing.

## Cache behavior

The source-hosted and self-hosted builds use a byte-based runtime-content
fingerprint, so a changed runtime cannot silently reuse an incompatible local
archive. Locally, runtime objects live only for the duration of archive creation;
copied sources, dependency ZIP files, and individual object files are never
runtime cache artifacts. A compatible Clang PCH is retained alongside the `.a`
to avoid reparsing the runtime interface for every generated translation unit.
GitHub Actions persists only Oilpan and mimalloc paths. Runtime archives and PCH
files are deliberately absent from the cross-run Actions cache, preventing
runtime variants from accumulating there.

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: OpenAI
