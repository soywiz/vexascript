---
layout: blog-post.njk
title: Native VexaScript performance compared with Node.js
date: 2026-07-22
category: Performance
summary: Measurements from the native compiler show where C++ became faster than Node.js, which changes helped, and where Node remained faster.
tags: blog
permalink: /blog/native-faster-than-node.html
---

On July 22, 2026, one native VexaScript compiler build ran faster than the
matching Node.js build on the measured self-hosting workload. This result only
applies to the recorded machine, compiler version, and source revision.

## **Recorded results**

The measurements below came from the same darwin/arm64 development machine,
but not always from the same compiler revision. They are separate checkpoints.

| Checkpoint | Native | Node.js | Result |
| --- | ---: | ---: | ---: |
| `-O1` compiler with mimalloc | 3.28 s | about 4.03 s | Native faster |
| `-O3` compiler with mimalloc | 3.08 s | 4.14 s | Native 25.6% faster |
| Later runtime workload | 7.82 ms | 41.25 ms | Native 5.28× faster |
| Later self-host build with changed source | 2.37 s | 2.15 s | Node about 10% faster |

The final row is included because the source graph and generated code had
changed. Native code was faster at one checkpoint, but it did not stay faster
for every later workload.

## **Changes that reduced native work**

Profiling found many small costs instead of one slow function.

| Cost | Change |
| --- | --- |
| Boxing known primitive values | Generate direct primitive operations |
| Repeated string allocations | Join known string parts with one allocation |
| Text keys in hot lookups | Use numeric or typed identifiers where possible |
| Collection copies | Add copy-on-write storage for typed `Map` and `Set` |
| Repeated regular-expression parsing | Cache compiled expressions |
| Array growth | Reserve capacity when the result size is known |

One compiler change reduced calls to the generic dynamic `add` helper from
1,259 to 10 in the generated self-hosting file. Most string concatenation could
then use direct string code.

## **The BigInt division fix**

The native `BigInt` implementation originally used bit-by-bit division for
every divisor. That was unnecessary when the divisor fit in one 32-bit limb.
The benchmark divided a growing value by `3n` many times, so this slow case
dominated the result.

A one-limb fast path reduced the measured BigInt section from 1.33 ms to
0.08 ms. Multi-limb divisors still use the general algorithm. Tests cover
positive and negative values, large one-limb divisors, and the fallback.

## **The mimalloc comparison**

The allocator test compiled one `-O1` object and linked that same object twice.
Only the allocator changed.

| Allocator | Median of three hot runs |
| --- | ---: |
| System allocator | 4.08 s |
| mimalloc 3.4.3 | 3.28 s |
| Reduction | 19.6% |

An earlier attempt used dynamic allocator injection, but it intercepted no
relevant allocations. Linking the allocator directly produced a valid
comparison. Sanitizer builds do not use mimalloc because the sanitizers need to
control allocation tracking.

## **Limits of the result**

Some attempted optimizations made performance worse. Repeated string appends
were slower than an exact-size join. Increasing the Oilpan heap limit from 2 GB
to 4 GB increased the median from 2.37 s to 2.57 s. `-O3` improved runtime but
also raised native compilation time from 108.0 s to 129.9 s.

These results show that the C++ backend can outperform Node.js when the compiler
keeps static types and avoids unnecessary allocations. They do not show that
native VexaScript is always faster. Benchmarks remain informational; automated
tests check correctness without using machine-specific time limits.
