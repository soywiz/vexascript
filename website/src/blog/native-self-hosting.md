---
layout: blog-post.njk
title: The native compiler completes its first self-host
date: 2026-07-19
category: Compiler milestone
summary: The first complete compiler-to-C++-to-compiler roundtrip, including the UTF-16 performance trap and the type boundaries that failed across generations.
tags: blog
permalink: /blog/native-self-hosting.html
---

Commit `58703ec2` completed the first native CLI self-host roundtrip on July 19, 2026. A compiler built from generated C++ ran the ordinary `cli/cli.ts` entrypoint and emitted the next complete compiler translation unit. The initial run was slow, but it established a much stronger condition than compiling a native language sample.

## **What the roundtrip executed**

The native executable did not call back into Node.js for compilation. It loaded the TypeScript project, ran the VexaScript compiler pipeline, assembled the native module graph, and emitted C++ for the compiler again.

| First-roundtrip measurement | Value |
| --- | ---: |
| Date | 2026-07-19 |
| Commit | `58703ec2` |
| Unoptimized native generation time | 171 seconds |
| Generated translation unit | approximately 6.6 MB |
| Initial change size | 29 files, 1,401 insertions, 596 deletions |
| Entrypoint | ordinary `cli/cli.ts` |
| Output | next compiler C++ translation unit |

The native language smoke remained in the suite, but it could not substitute for this check. The compiler graph contains large recursive type operations, declaration loading, async filesystem boundaries, dynamic collections, and long emission paths that application-sized fixtures do not combine.

## **The “hang” was an accidental quadratic conversion**

The first serious profile looked like a compiler hang during tokenization. Sampling showed that `charCodeAt(Text)` had selected an old `std::string` overload through an implicit conversion. Each character lookup converted the complete UTF-16 source to UTF-8 and then back to UTF-16.

| Operation | Intended cost | Accidental cost |
| --- | ---: | ---: |
| One `charCodeAt` | O(1) | O(source length) conversion |
| Tokenizing N characters | O(N) | Approximately O(N²) |
| Complete compiler input | Seconds expected | Appeared stalled |

Adding a direct UTF-16 `Text` overload restored constant-time indexing. The broader lesson was that replacing a runtime string type is not complete until primitive helpers, overload sets, collection traits, and dynamic views all move together. Leaving the old `std::string` overload available allowed C++ overload resolution to choose a legal but disastrous path.

## **Async native I/O required a heap boundary**

The CLI validates TypeScript with an external `tsc --noEmit` process. A blocking `waitpid` on the runtime thread would violate the compiler's asynchronous I/O contract and stop timers or promises. The native adapter therefore starts captured child-process work on a background future and resumes the main event loop with copied results.

The worker cannot retain Oilpan pointers. Command arguments and plain option data are copied before the task starts, and the eventual stdout/stderr/exit data is transferred back as ordinary owned values. This same rule later became the basis for asynchronous FFI calls: blocking native work may leave the runtime thread, managed heap pointers may not.

## **Why later generations failed after the first one passed**

Generated compiler code must preserve its own static contracts. Several TypeScript callbacks were semantically known to return `AnalysisType`, but the native emitter inferred them dynamically or as `void`. The first compiler could build; the compiler it emitted then constructed malformed type arrays containing missing values.

| Boundary | Failure in a later generation | Correction |
| --- | --- | --- |
| `map`/`filter` callbacks | Concise callback return became `void` | Preserve explicit callback result types |
| Union construction | `undefined` entered `AnalysisType[]` | Normalize invalid members to `UNKNOWN_TYPE` at `unionType` |
| Generic substitution | Recursive type arguments lost their static type | Add explicit `AnalysisType` contracts to recursive maps |
| Computed member arguments | `Expr[] -> AnalysisType[]` reused the input element type | Annotate the cross-domain mapping explicitly |
| Type comparison cache | Missing values became illegal `WeakMap` keys | Reject absent operands before cycle-cache access |
| Optional collection call | Receiver optionality disappeared in emitted C++ | Route all native collection calls through the shared optional-receiver path |

Adding null guards only where a crash surfaced was rejected as the main strategy. A missing value produced by an upstream callback can crash many consumers. Fixing the producer and hardening invariant boundaries such as `unionType` keeps malformed types from escaping into the rest of analysis.

## **TypeScript validation stayed external but asynchronous**

VexaScript does not pretend that its own type checker implements every TypeScript type-system feature. For `.ts` and `.tsx` projects, `tsc --noEmit` remains the semantic authority. Once that passes, VexaScript reuses its parsed artifacts for binding, lowering, and C++ emission without reporting known compatibility false positives. `.vx` sources still use the VexaScript checker.

| Source mode | Semantic authority | VexaScript work after validation |
| --- | --- | --- |
| `.vx` | VexaScript type checker | Diagnostics, lowering, JS/C++ emission |
| `.ts` / `.tsx` | TypeScript `tsc --noEmit` | Parsing, binding, inference metadata, lowering, JS/C++ emission |
| `--transpile-only` | Explicitly skipped | Parsing, analysis required for emission, no semantic gate |

## **What “complete” meant after stabilization**

The July 19 sequence did not stop at the first 171-second output. Later commits on the same day validated TypeScript from the native CLI, stabilized UTF-16 record keys and async roots, and made repeated native compiler output byte-stable across hosts.

The milestone is useful because it forces representation errors to compound. A wrong callback type, lost optional receiver, or unsafe worker pointer may survive one application run; it is much more likely to fail when the program being compiled is the compiler that must reproduce those same semantics in its child generation.
