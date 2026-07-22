---
layout: blog-post.njk
title: Pixi serve rebuilds fall from 200 ms to about 50 ms
date: 2026-07-22
category: Developer experience
summary: A measured account of the caches, invalidation rules, and remaining reload boundary behind faster Pixi entry edits.
tags: blog
permalink: /blog/pixi-incremental-serve.html
---

On July 22, 2026, the Pixi sample exposed an important distinction in incremental compilation: keeping a process alive is not the same as reusing compiler work. `vexa serve samples/pixi` already watched the project, but changing its small `html.vx` entry still produced consecutive rebuilds of 212 ms and 201 ms. The edit was tiny; most of the project was unchanged. The rebuild path nevertheless reconstructed analysis indexes and rendered stable vendor modules again.

Commit `98eb0b17` made the serve session own reusable compiler and bundler state. The resulting steady-state rebuilds measured 52 ms and 45 ms. This article records which work became reusable, which changes invalidate it, and why the browser still performs a full page reload.

## **Measure phases before designing caches**

The first change was observability. A single “Bundled in 201ms” line could not distinguish parsing from semantic analysis, JavaScript emission, dependency resolution, bundle assembly, filesystem writes, or the watcher debounce. Phase timings were added around the actual project pipeline using a monotonic high-resolution clock. They apply to `build`, `cpp`, and `executable`, rather than being a special Pixi profiler.

Representative measurements from the work were:

| Scenario | Parse | Analysis | Emit | End-to-end total |
|---|---:|---:|---:|---:|
| Initial Pixi bundle | 2 ms | 94 ms | 5 ms | 1,831 ms |
| First entry rebuild after startup | 1 ms | 83 ms | 2 ms | 93 ms |
| Steady-state watcher rebuilds | included in pipeline | included in pipeline | included in pipeline | 52 ms / 45 ms |
| Previous steady state | not separately reported | not separately reported | not separately reported | 212 ms / 201 ms |

The table is deliberately not a claim that parsing, analysis, and emission add up to the initial total. Initial startup also loads configuration and packages, resolves the graph, prepares the bundle, and performs filesystem work. The missing time was outside the three headline compiler phases. Exposing both phase and total timings prevented a fast parser from hiding a slow surrounding pipeline.

The numbers also changed the optimization target. Package discovery was expensive at cold start, but it was not the main cause of repeated entry edits. Stable DOM and Pixi declarations were being re-indexed, module typing contexts were being rebuilt, and multi-megabyte vendor factories were being serialized again.

## **The serve session now owns stable state**

The incremental path keeps data only when its inputs provide a defensible identity. It does not globally memoize arbitrary compiler objects. The long-lived serve session retains:

| Reused artifact | Identity or validity condition | Work avoided |
|---|---|---|
| Module typing context | Stable module and import fingerprint | Reconstructing type information for unchanged dependencies |
| Ambient declarations | Stable declaration identity | Re-indexing DOM and library declarations |
| Declaration-node sets | Same analyzed declaration graph | Rebuilding type-checker lookup sets |
| Resolved dependency map | Unchanged imports and configuration | Re-resolving the module graph |
| Emitter runtime seeds | Compatible emission configuration | Recreating stable runtime metadata |
| Vendor module factory text | Unchanged vendor module and emission inputs | Re-rendering large Pixi dependency factories |

Pre-rendering vendor factories is particularly important. An unchanged package does not become cheap merely because its AST is cached if the bundler still walks that AST and generates the same large string for every entry keystroke. Caching at both the semantic and final-factory boundaries removes work from the two dominant sides of the pipeline.

This is one cache graph, not a collection of disconnected fast paths. The entry update reuses the same resolved modules and type data that feed normal compilation, then substitutes only the changed entry output during bundle assembly. That keeps `serve` behavior aligned with `build` instead of creating a second compiler with subtly different rules.

## **Invalidation is conservative by design**

An incremental compiler is correct only if its invalidation rule is at least as precise as its reuse rule. VexaScript takes the narrow path for the common case and falls back to a broader rebuild when it cannot prove stability.

| Change | Incremental response |
|---|---|
| Body-only edit in the entry module | Reparse and reanalyze the entry; reuse stable dependencies and factories |
| Entry import fingerprint changes | Re-resolve the affected graph and rebuild dependent typing state |
| Non-entry source changes | Conservatively invalidate the broader cached project state |
| Compiler or project configuration changes | Recreate state under the new configuration |
| Vendor dependency remains unchanged | Reuse its analyzed state and pre-rendered factory |

This choice matters more than a benchmark. Reusing a typing context after its import assumptions changed could produce a fast but stale build. The implementation therefore treats fingerprints and declaration identity as part of correctness, not as optional cache hints.

The watcher debounce was reduced from 75 ms to 20 ms after event coalescing was reliable. That saves visible latency without pretending debounce time is compiler time. Reporting both the internal phases and the end-to-end total keeps the distinction observable.

## **Why fast rebuild still means full browser reload**

The compiler-side update is incremental; the browser update is intentionally a page reload. Pixi owns an application instance, canvas, ticker callbacks, GPU resources, and event handlers. Re-importing the entry module without a disposal protocol would leave the previous instance alive and attach a second one. That is memory leakage disguised as hot-module replacement.

Safe HMR would require an explicit lifecycle contract: the old module must dispose its ticker, listeners, renderer, and canvas before the new module becomes active. VexaScript does not invent that contract for an arbitrary application. A full reload gives the browser a trustworthy cleanup boundary while the faster compiler makes that reload arrive sooner.

## **What the result actually establishes**

The measured steady-state improvement is roughly fourfold: about 200 ms became about 50 ms for repeated edits to this sample on the same development machine. It does not claim that every project rebuild is 50 ms, nor that cold startup is solved. It establishes a reusable architecture and a measurement vocabulary:

- keep parsed and analyzed dependency state under explicit identities;
- cache final vendor rendering as well as intermediate ASTs;
- invalidate on import, configuration, or non-entry changes when proof is insufficient;
- report compiler phases separately from total watcher latency;
- keep browser lifecycle correctness independent from compiler incrementality.

That is a more useful outcome than a single benchmark. Future regressions can now be assigned to a phase, and future incremental work has an explicit state and invalidation model to extend.
