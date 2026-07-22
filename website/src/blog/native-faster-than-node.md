---
layout: blog-post.njk
title: Native VexaScript becomes faster than Node.js
date: 2026-07-22
category: Performance
summary: A measurement-driven account of the static representation, allocation, string, BigInt, and toolchain changes behind the first native-over-Node crossover.
tags: blog
permalink: /blog/native-faster-than-node.html
---

On July 22, 2026, the generated native compiler crossed the equivalent Node.js execution time on the measured self-host workload. This post keeps the individual checkpoints separate because several numbers came from different optimization stages; combining them into one smooth benchmark series would be misleading.

## **Measurement matrix**

The journals record two related but distinct workloads: complete compiler generation and a smaller runtime benchmark. Timings are medians or representative wall times on the same darwin/arm64 development machine, but they were captured at different commits.

| Checkpoint | Native | Node.js | Result |
| --- | ---: | ---: | ---: |
| Early O1 self-host profile | ~4.25 s | not recorded in that sample | Baseline |
| Allocation-profile O1 compiler | ~3.63 s | ~4.03 s | Native first moves ahead |
| O1 compiler with Apple nano allocator | ~3.34 s | ~4.03 s | Informational platform experiment |
| Same O1 object, system allocator | 4.08 s median | — | Controlled allocator baseline |
| Same O1 object, mimalloc 3.4.3 | 3.28 s median | — | 19.6% lower wall time |
| O3 + mimalloc compiler | 3.08 s median | 4.14 s median | Native 25.6% faster |
| Later complete runtime workload | 7.82 ms | 41.25 ms | Native 5.28× faster |
| Separate later self-host checkpoint | 2.37 s | 2.15 s | Node still ~10% faster for that changed graph |

The last row is not a contradiction. The compiler source, generated representation, warm-up state, and measurement point changed. It is included because performance work should preserve unfavorable data too. “Native surpassed Node” describes a verified checkpoint, not a permanent universal property of every revision and workload.

## **Where the native compiler spent time**

CPU sampling showed no single dominant algorithm. C++ emission repeatedly paid for small operations that JavaScript engines optimize aggressively:

| Hot cost | Why it multiplied | Change |
| --- | --- | --- |
| Dynamic `Value` boxing | Statically known primitives crossed generic runtime helpers | Emit direct primitive conversions and specialize boxing |
| UTF-16 allocation | Template/string concatenation built many intermediate strings | Flatten known concatenation trees and pre-size joins |
| String-keyed lookups | AST/type discriminators and property metadata used text repeatedly | Move hot discriminators to numeric or nominal forms |
| Collection copies | JavaScript copy semantics became eager C++ storage copies | Copy-on-write typed `Map`/`Set` storage |
| `std::function` erasure | Higher-order callbacks allocated/indirected unnecessarily | Retain concrete callable types |
| Regex construction | Repeated literals reparsed identical UTF-16 patterns | Cache compiled regular expressions |
| Persistent handles | Temporary values were rooted more broadly than needed | Preserve static storage and shorten root lifetimes |
| Array growth | Transform results repeatedly reallocated | Reserve known result capacity and move safe temporaries |

One measurable emitter change reduced dynamic `add` calls in the generated self-host translation unit from 1,259 to 10. That number is more diagnostic than a microbenchmark: it shows that the compiler stopped routing known string concatenation through the generic dynamic operator path.

## **BigInt exposed an algorithmic hot path**

Native `BigInt` used base-2³² limbs. Its first division implementation handled all divisors with bit-at-a-time long division, including the common case where the divisor fits in one limb. The benchmark repeatedly divided a growing value by `3n`, so the general algorithm dominated.

A single-limb fast path performs one linear pass using the existing small-division primitive. Signed quotient and remainder behavior stays shared with the fallback; multi-limb divisors still use general division.

| BigInt measurement | Before | After |
| --- | ---: | ---: |
| Reported native BigInt section | 1.33 ms | 0.08 ms |
| Complete native workload | — | 7.82 ms median |
| Equivalent Node.js workload | — | 41.25 ms median |
| End-to-end ratio at that checkpoint | — | 5.28× native speedup |

The focused C++ test covers positive and negative operands, a divisor close to the 32-bit limit, and the multi-limb fallback so the performance shortcut cannot change arithmetic semantics silently.

## **Allocator comparison was controlled at the link step**

Setting `DYLD_INSERT_LIBRARIES` initially reported no intercepted allocations. That dead end mattered: it meant the experiment was not observing the allocator used by the relevant C++ containers. The valid comparison compiled the generated compiler once to the same O1 object and linked that exact object alternately with the system allocator and mimalloc.

| Controlled link experiment | Median of three hot runs |
| --- | ---: |
| System allocator | 4.08 s |
| mimalloc 3.4.3 | 3.28 s |
| Reduction | 19.6% |

Native release builds therefore link a cached mimalloc override object. Sanitizer builds omit it so AddressSanitizer and UndefinedBehaviorSanitizer keep control of allocation instrumentation.

## **Rejected optimizations**

| Attempt | Result | Why it was rejected |
| --- | --- | --- |
| Repeated `std::u16string +=` instead of exact-size join | Slower | Reallocation and copying outweighed simpler code |
| Increase Oilpan initial heap ceiling from 2 GB to 4 GB | 2.37 s -> 2.57 s median | More heap was not the bottleneck and worsened locality/collection behavior |
| Dynamic allocator injection | No intercepted allocations | Did not measure the allocator actually used |
| O3 everywhere | Compile time 108.0 s at O1 -> 129.9 s at O3 | Runtime improved, but native build latency increased materially |

## **What the crossover does and does not prove**

It proves that VexaScript's C++ representation can beat the Node.js execution of the same compiler workload when static types survive into generated code and ordinary native allocation is tuned. It does not prove that native is always faster, that every compiler revision stays ahead, or that startup-heavy programs benefit equally.

The performance suite therefore formats measurements without hard machine-specific thresholds. Correctness tests enforce arithmetic, byte-stable repeated output, and runtime behavior; benchmark tables remain evidence to guide profiles, not flaky pass/fail conditions.
