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
