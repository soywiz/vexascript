# Native Conversion Elision Requires Emitted-Representation Proofs

## Context

The native compiler translation unit still contained more than twenty-four
thousand `convertValue` calls. Reusing the semantic expression type as proof
that a conversion was redundant initially looked attractive and removed more
than ten thousand calls from the generated source.

## Failed broad optimization

The broad change passed TypeScript validation and the complete native language
smoke, but compiling the self-hosted compiler exposed invalid calls involving
`Text`, `double`, and `Value`. The semantic type and the emitted C++ storage type
are not interchangeable. In particular, an inferred local may be recorded as
`vexa::Value` while its declaration uses C++ `auto` and therefore stores a
concrete `Text` or `double`.

Restricting the same optimization to the existing local C++ type map still
failed for the same reason. The map currently mixes declared/expected
representations with the representation actually selected by an `auto`
initializer.

A second attempt moved computed accesses recognized by
`isManagedArrayExpression` ahead of the dynamic-value fallback. It removed 181
dynamic-get sites and passed the complete language smoke, but the first native
self-host execution failed with `Value is not an array`. That predicate also
contains semantic evidence that is insufficient to prove the receiver's actual
C++ representation. The ordering change was reverted.

## Retained direction

Conversion elision is now limited to syntax with an emitter-owned proof of its
actual representation, including literals and resolved native property getters.
Future expansion should first introduce one authoritative emitted-storage type
for variables and expressions, then make declarations and conversions consume
that source of truth. Semantic `AnalysisType` equality alone is insufficient.

Statement-position assignments are a separate safe optimization. Their result
is discarded by language semantics, so the emitter can produce a scoped C++
block instead of an immediately invoked lambda while retaining single
evaluation of receivers, keys, and operands.

On the self-hosted compiler this reduced statement-position immediately
invoked lambdas from 319 to zero, total immediately invoked lambdas from 2,373
to 2,045, `convertValue` calls from 24,721 to 24,519, and generated source from
7,904,605 to 7,886,347 bytes. The `-O1` host compilation time remained about
112.9 seconds, so the source simplification is useful but not the dominant C++
compiler bottleneck.

## GC experiment

Oilpan's default initial heap is one megabyte. On the same `-O1` self-hosted
compiler binary, default runs took 13.45–14.10 seconds, while an initial
256-megabyte threshold took 12.60–12.72 seconds. The improvement confirms that
collection pressure is material, but imposing that retention policy on every
native application would be inappropriate. The runtime therefore exposes
`VEXA_NATIVE_INITIAL_HEAP_MB` as an opt-in tuning control.

## Self-host verification

The Node-hosted compiler and two consecutive native self-hosting roundtrips
produced byte-identical C++ output: 7,886,347 bytes with SHA-256
`227608ff0f1946d1d8ed6971fb9b87f9c74e0fe1f15e23c83d3dd84323139056`.
With the 256-megabyte initial-heap setting, the two native generations took
12.7416 and 12.7180 seconds internally. This provides an end-to-end guard that
the retained optimizations preserve compiler behavior, not merely small native
fixtures.

## Numeric analysis-type discriminators

`AnalysisTypeKind` was migrated from string literals to a numeric `const enum`,
and tests now construct the same nominal analysis-type classes used by the
compiler instead of anonymous objects that only resemble them. Three
interleaved native self-host generations with a 4096 MB initial heap measured a
7.65-second median CPU time for the numeric discriminator and 7.74 seconds for
the string checkpoint. Median wall time moved from 8.70 to 8.64 seconds. The
generated source grew from 7,885,854 to 7,912,467 bytes and the `-O1` build
remained in the existing 110-second band, so discriminator comparisons were not
a major frontend or execution bottleneck.

The generated base class now stores `kind` as `std::int32_t`, but functions
whose source type is the `AnalysisType` union still receive `vexa::Value` and
read the discriminator dynamically. That boundary also increased generated
`convertValue` calls because the emitter boxes enum values while moving between
the dynamic union and concrete classes. The next useful change is therefore a
representation rule: when every member of a source union is a nominal class
derived from the same base, emit the common base pointer and use discriminator
narrowing to select concrete subclasses. More local discriminator rewrites
cannot remove that boxing.

Changing `typeFromTypeNameLooseWithTypeParameters` from an optional string
parameter to the string every caller already supplies removed one dynamic
native boundary, but complete generation timings remained flat. This is still
the correct declared contract; it is evidence that isolated signature cleanup
is too small to measure without a broader representation change.

Increasing `VEXA_NATIVE_INITIAL_HEAP_MB` from 256 to 4096 reduced the same
native generation from roughly 13.5 to 8.7 seconds, at the cost of physical
memory peaking around 2 GB. Sampling the larger-heap run moved the dominant
cost from Oilpan marking and sweeping to allocation, persistent-root handling,
text conversion, and dynamic access. The setting remains opt-in because the
memory tradeoff is unsuitable as a default; it is useful for separating GC
pressure from allocation and representation costs during profiling.

After import cleanup, the Node host and two consecutive rebuilt native hosts
produced byte-identical 7,912,467-byte translation units with SHA-256
`3c2ea8562a13c55187e5d7562abe75a6e9a1d976334e38274920382ed7d36c01`.
The two native generations took 16.40 and 16.42 wall-clock seconds externally
(8.78 and 9.14 CPU seconds), and their `-O1` builds took 115.48 and 122.94
seconds. The emitted program therefore remains deterministic and operational
through two full native self-host generations; build throughput, rather than
roundtrip correctness, remains the dominant iteration cost.

## Box pooled string values once

Sampling a large-heap run still showed `Value(StringObject*)` and Oilpan
persistent-root registration in the hot path even though literal
`StringObject` instances were already pooled. Generated expressions rebuilt a
boxed `Value` around the retained raw pointer on every literal use. The runtime
now owns one boxed literal value in a stable deque, and generated static slots
refer to that value. Runtime shutdown clears the boxed values before destroying
the Oilpan heap, so this does not rely on leaked process-global roots.

On the self-host translation unit, the change removed all 2,427 generated
`vexa::Value(__vexa_literal_...)` constructions and reduced source size from
7,912,467 to 7,859,722 bytes. Two latest interleaved 4096 MB comparisons took
8.70 and 8.67 seconds for the previous host versus 8.36 and 8.37 seconds for
the boxed-literal host. At 256 MB, previous runs took 12.66 and 12.64 seconds
versus 12.51 and 12.52 seconds after the change. The pure `-O1` build took
109.09 seconds, which is not distinguishable from the existing C++ build-time
variance. Node and all benchmarked native runs emitted byte-identical output
with SHA-256
`c6541189e30188b675354bce3b143ad766f3847a4bd44aa14e520a21fed6e1f5`.

The pure Node output and two consecutive rebuilt native hosts also produced
that exact hash. Their `-O1` builds took 109.09 and 107.54 seconds; representative
native generations took 8.46 and 9.05 seconds with the 4096 MB profiling heap.
This separately verifies the runtime-owned boxed-literal lifetime through a
complete rebuild and process shutdown, beyond the focused native smoke.

An adjacent common-base-pointer experiment mapped the `AnalysisType` nominal
union to `AnalysisTypeBase*`. It reduced dynamic gets from 1,397 to 326 and
removed 688 conversions, but exposed 61 `Record<string, AnalysisType>`
boundaries that still store record values as dynamic `Value`. Keeping the base
pointer at that point required unsafe implicit casts or dozens of source-side
casts, so the experiment was reverted. The durable next step is a typed record
representation (or migrating those compiler records to typed maps/classes),
then re-enabling the already validated common-base union rule. Contextual array
and destructuring changes that did not improve the stable output were also
removed rather than retained as speculative scaffolding.

## Typed analysis maps unlock the common-base representation

The compiler's `ObjectType.properties` and generic constraint/default tables
were migrated from `Record<string, AnalysisType>` to typed maps. The common-base
union rule could then be enabled without unsafe casts: a union whose members are
nominal class pointers now uses their nearest shared native base. Compiler code
that reads a subclass after checking its numeric discriminator keeps an explicit
nominal cast, and mixed map-entry destructuring was replaced with typed
`keys()`/`get()` loops where it would otherwise manufacture heterogeneous
`Value` tuples.

The first attempt exposed an important second-order issue. Every optional class
property had previously used `Value`, including arrays and managed object
pointers. Changing the analysis representation therefore made valid static
assignments fail against Oilpan `Member<T>` storage. The durable fix was not to
restore boxing: optional managed fields and constructor properties now retain
their declared pointer type, assignment emission recovers that storage type,
and the nullish/optional runtime helpers accept `Member<T>` directly. Primitive
optional fields still use `Value`, preserving the observable distinction among
numeric zero, `null`, and `undefined`.

Explicit callback return annotations also have to outrank a weaker contextual
or inferred `any` result. Without that rule, typed map and array callbacks were
still emitted as `Value` even though their source signatures declared
`AnalysisType`. The shared arrow/function-expression path now applies the
explicit result first. Two `map(...).filter(...)` chains in the checker were
replaced by direct typed loops because nullable callback arrays unnecessarily
lost their element representation and allocated intermediate arrays.

Against the boxed-literal checkpoint, the Node-emitted self-host translation
unit decreased from 7,859,722 to 7,782,548 bytes. Generated `dynamicGet`
occurrences decreased from 2,614 to 1,733, and `convertValue` occurrences from
25,145 to 20,963. The complete file passes a native C++ syntax check; the
unified native language smoke compiles, runs, and matches its expected output.
The full 2,312-test suite and the CLI sanity program also pass. That intermediate
Node output had SHA-256
`4d26f881c05994cf55c73206433836954f72ba4075ee0da09b02466644652627`;
the following sections record the execution and rebuilt-roundtrip validation.

## Typed callback and collection boundaries must preserve object identity

The first complete execution after the analysis-map migration exposed three
runtime representation gaps that syntax validation could not find. Constructing
`Map` or `Set` from an absent optional source dereferenced a null native pointer;
the collection constructors now treat that source as an empty iterable. A
generic callback declared to return a generated class pointer was then stored in
`std::function<Value()>`, where overload resolution selected `Value(bool)` for
the pointer. A constrained generated-object pointer constructor now boxes the
object itself. The unified native smoke covers both failures.

Typed map access also reached a map with a different native specialization.
`MapObject` now exposes its common `MapLikeObject` identity through dynamic
casting, and `convertValue<TypedMap*>` creates a live typed view when an exact
specialization is unavailable. Reads still convert at the declared key/value
boundary and include the offending key in conversion errors. This preserves the
shared backing map instead of copying entries.

## Builtin result types must not depend on boxed semantic metadata

Node and the first native host eventually differed by one redundant conversion
around `Number(...)`. The native compiler represented the nullable return of
`emittedCppTypeForExpression` as `Value`, so an otherwise syntax-known builtin
type could be lost when `emitConvertedValue` recursively emitted conditional
branches. A non-null `builtinCallCppType` helper now provides the `String` and
`Number` native representations to both type prediction and conversion
emission. This removed the host-dependent decision rather than normalizing the
finished source text.

Removing the redundant `String(...)` conversion exposed a latent mismatch: the
emitter had always classified it as UTF-16 `vexa::Text`, while the runtime helper
returned UTF-8 `std::string`. The runtime now returns `Text`, keeping the actual
representation aligned with the emitter and with the UTF-16 in-memory string
policy. The complete native smoke passed after that change.

The final checked translation unit is 7,797,600 bytes. Its Node generation took
6.00 seconds externally and its `-O0 -DNDEBUG` native build took 22.63 seconds.
Two consecutive native compilers completed checked semantic generations in
106.14 and 107.61 seconds. Node and both native generations are byte-identical
with SHA-256
`438e08c2e151dfcf28fc7fa8b07a1dc579399f6d46a0470215412f5bb986c6c1`.
