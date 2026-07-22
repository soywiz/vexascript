---
layout: blog-post.njk
title: Native VexaScript becomes faster than Node.js
date: 2026-07-22
category: Performance
summary: Profiling, static representations, allocation work, and mimalloc pushed native compiler generation beyond the equivalent Node.js run.
tags: blog
permalink: /blog/native-faster-than-node.html
---

On July 22, the self-hosted native compiler became faster than the equivalent Node.js compiler run on the same generated workload.

This was not one magic optimization. Profiles showed that C++ emission was dominated by many small UTF-16 allocations, dynamic `Value` conversions, string-keyed lookups, collection copies, and persistent-handle bookkeeping. The compiler and runtime progressively preserved static primitive and collection representations, flattened known string concatenations, cached regular expressions, reserved result arrays, and removed avoidable callback type erasure.

The first measured crossover put an O1 native compiler near 3.63 seconds against roughly 4.03 seconds for Node.js. Linking the same generated compiler object with mimalloc 3.4.3 reduced repeated native runs by another 19.6%. An O3 checkpoint then reached a 3.08-second median against 4.14 seconds under Node.js: native generation was 25.6% faster for that compiler workload.

Smaller runtime workloads showed the ceiling more clearly. A complete BigInt benchmark fell from 41.25 ms in Node.js to 7.82 ms natively, a 5.28× end-to-end speedup, after a single-limb division fast path removed repeated general long division.

The benchmark numbers are historical measurements, not test thresholds; machines and load vary. The durable result is the architecture behind them: analyzed static types now survive far enough into C++ to avoid paying dynamic JavaScript-style costs where the program does not need them.
