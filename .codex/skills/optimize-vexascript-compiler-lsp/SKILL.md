---
name: optimize-vexascript-compiler-lsp
description: Optimize or regression-test VexaScript compiler and LSP work using deterministic counters, cache metrics, cold/warm deltas, and bounded semantic work instead of wall-clock pass/fail thresholds. Use for slow editor requests, repeated parsing or resolution, cache/invalidation problems, concurrent request duplication, compiler throughput regressions, or performance-sensitive refactors.
---

# Optimize VexaScript Compiler and LSP

Make performance claims from deterministic work evidence. Treat elapsed time and CPU profiles as diagnostic signals, never as the acceptance criterion.

## Establish the workload

1. Reproduce the exact user-visible operation through the real compiler or editor path: compile, diagnostics, hover, completion, navigation, semantic tokens, or a realistic request burst.
2. Preserve correctness first. Add the smallest semantic regression when the slow path also returns a wrong or degraded type.
3. Record cold, immediate warm, and concurrent/burst variants when caching or pending-work reuse is relevant.
4. Use a real package sample as broad coverage, but do not add sample-owned `any`, `unknown`, declaration shims, casts, or suppressions to bypass compiler work.

## Measure semantic work

Prefer counters that correspond to meaningful units:

- public requests and actual executions;
- cache hits, misses, invalidations, and negative-cache hits;
- pending-promise or in-flight request reuse;
- session, program, parser, resolver, or index builds;
- filesystem probes, declaration collections, workspace scans, and module resolutions;
- candidate, node, symbol, or declaration visits when one traversal is the hotspot.

Expose read-only snapshot and reset APIs at the owning subsystem. Keep counters queryable after the request, monotonically incremented during a snapshot interval, and behavior-neutral. Do not create synchronized duplicate metric stores when the owner can publish its own counters.

Take a baseline snapshot, execute one operation, then subtract snapshots for a request-local delta. For a warm assertion, warm the relevant state first and measure only the next request. Name counters after the work they count, not after an implementation detail that may disappear.

## Write deterministic assertions

Assert relationships and bounded work, for example:

- one request produces one semantic execution;
- a warm request adds one cache hit and zero builds, parses, or filesystem probes;
- concurrent cold requests produce one build plus pending-work reuse;
- an exclusive completion context performs zero workspace-export scans;
- invalidation causes exactly the expected cache miss and rebuild;
- a request visits no more than the justified number of declarations or candidates.

Use exact equality when the architecture promises exact reuse. Use a small upper bound when traversal order or a valid alternative path can vary. Document why the bound represents expected work.

Never make milliseconds, seconds, CPU percentage, or machine-dependent throughput a test pass/fail condition. A timing table may accompany the counters as observational evidence. If elapsed time stays high while deterministic work is bounded, capture a CPU profile to locate expensive work inside a single legitimate execution, then add a semantic counter at that layer if it can protect the fix.

## Optimize the shared path

1. Find the earliest shared layer responsible for repeated work.
2. Reuse one canonical cache, index, session, resolver, or traversal rather than adding a parallel fast path.
3. Share in-flight promises for concurrent cold requests and cache negative results when invalidation can make them safe.
4. Keep invalidation explicit and test that watched-file or document changes clear only the affected state.
5. Defer expensive work until a feature actually needs it. An exclusive contextual result must not fall through to unrelated global discovery.
6. Delete superseded branches after unifying the path.

Shared compiler code must remain browser-compatible, asynchronous for I/O, free of top-level await, and free of Node APIs outside explicit adapters.

## Validate

Add focused tests for the counter invariant and the semantic result. Re-run the exact real-world workload and compare cold/warm/burst snapshots. Then run:

```sh
pnpm test
pnpm cli vexa testFixtures/sample.vx
```

When a browser-facing editor behavior changed, validate it in a real browser as required by the repository policy.

Record costly dead ends, the decisive counters, the architectural cause, and the final invariant in `docs/journal/`. Base new metric surfaces on the patterns in:

- `docs/journal/2026-08-16-queryable-lsp-work-metrics-and-hover-formatting.md`
- `docs/journal/2026-08-11-contextual-completion-workspace-scan-latency.md`
- `docs/journal/2026-08-16-zod4-declaration-and-bundler-regressions.md`
