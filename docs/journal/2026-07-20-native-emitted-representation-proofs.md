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
