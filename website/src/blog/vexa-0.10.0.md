---
layout: blog-post.njk
title: VexaScript 0.10.0 makes native C++ an executable compiler path
date: 2026-07-25
category: Release announcement
version: 0.10.0
summary: VexaScript 0.10.0 turns the native C++ backend into a tested CLI workflow with Oilpan memory, cross-backend FFI, self-hosting coverage, and portable packaging checks.
tags: blog
permalink: /blog/vexa-0.10.0.html
---

VexaScript 0.10.0 is the next release after 0.9.4. The release candidate is
the `bac80503` commit from 2026-07-24, and the version preparation is dated
2026-07-25. Since 0.9.4, the repository accumulated 125 non-merge commits
across the compiler, native runtime, CLI, samples, website, and CI. The main
change is not a new spelling for C++ output: native compilation now has a
complete, testable command path from source to cached executable.

## **The release has one native command path**

The native CLI is grouped under `cpp`. The short form, `vexa cpp file.vx`,
emits a translation unit; `vexa cpp build file.vx` performs the explicit build
step; `vexa cpp link file.vx` produces a cached executable; and `vexa cpp run
file.vx` links and executes it. The nested command parser also gives each
operation its own help path, so the CLI and the website describe the same
interface.

The link and run commands persist the generated C++ path, source mtimes,
compiler version, compiler options, native flags, and relevant project
configuration. An unchanged source graph reuses the translation unit, and an
executable newer than that translation unit is reused without invoking `g++`.
This is deliberately a build cache rather than a second compiler pipeline:
configuration changes invalidate the native artifact while the normal parser,
analysis, lowering, and diagnostics remain shared.

## **The backend now has a managed runtime boundary**

The C++ emitter consumes the same analysis results used by JavaScript emission.
It maps analyzed `int`, `long`, `number`, and arbitrary-precision `bigint`
values to distinct native representations, preserves class and array identity,
and routes generated callables through an explicit `vexa::Runtime&`. Generated
objects, arrays, coroutine parameters, and captured receivers are rooted with
Oilpan-aware handles across asynchronous work and suspension.

Promises, `sync` functions, timers, and `go` use one runtime queue. Native
`Promise` construction is a source-level facade over the same `Task<T>` state
used by async functions, rather than a second promise implementation with a
different scheduler. Generators use one C++20 coroutine implementation for
synchronous and async-capable iteration. This leaves the semantics in one
place and makes the runtime boundary visible instead of relying on generated
JavaScript conventions.

The array representation changed during this work. An early `std::vector<T>`
mapping preserved element types but copied arrays when they crossed a function
or object boundary, and it could not trace Oilpan objects stored in elements.
The current `ArrayObject<T>` is an Oilpan-managed backing object; traced slots,
dynamic values, indexed access, iteration, collection methods, and formatting
share its implementation. The vector representation remains only where an
internal numeric range needs temporary materialization.

## **FFI declarations cross both backends**

Native library declarations now describe headers, libraries, linker options,
foreign structs, and raw implementation bodies at the source level. The same
declaration can produce a JavaScript/Deno adapter or native C++ bindings. The
SDL2 sample is the concrete integration check: it exercises typed foreign
structs, pointer-like handles, callbacks, and a dynamic binding path without
requiring handwritten generated C++.

The important boundary is ownership. A foreign pointer is not silently treated
as an Oilpan object, and an external buffer is valid only for the duration
defined by the FFI contract. This is intentionally narrower than pretending
that every native resource can be traced automatically. The declaration model
keeps the compiler-facing shape shared while leaving external allocation and
release responsibilities explicit.

## **Measured checkpoints explain what 0.10.0 establishes**

The following rows come from the native benchmark recorded on 2026-07-22. They
were measured on darwin/arm64 with AppleClang through `/usr/bin/g++`, a release
Oilpan build, and Node.js running JavaScript emitted from the same source.

| Metric | Native | Node | Native speedup |
| --- | ---: | ---: | ---: |
| Startup median | 5.47 ms | 35.06 ms | 6.41x |
| Workload median | 7.82 ms | 41.25 ms | 5.28x |
| Array workload | 0.88 ms | 2.20 ms | 2.50x |
| Bigint workload | 0.08 ms | 0.04 ms | 0.50x |
| Event-loop workload | 0.03 ms | 1.84 ms | 61.33x |

The native workload binary was 821,336 bytes, and fresh generation, compilation,
and linking took 2,875.72 ms. The larger self-hosted command, `cpp cli/cli.ts
--target optimized`, reached a 2.37-second warm median versus 2.15 seconds for
the matching Node CLI on the same machine. These measurements establish that
the native path is executable and competitive for selected workloads; they do
not establish that native compilation or every program is faster than Node.
Bigint arithmetic is the clearest counterexample in the table, and the
self-hosted compiler still has a small native wall-time disadvantage.

## **Portability and failure evidence remain part of the release**

The native packaging checks cover macOS, Linux, and Windows-specific paths in
the repository's CI. Windows validation found several assumptions that a local
macOS run could not expose: drive-rooted paths were being resolved as relative,
MinGW header revisions did not match the vendored V8 sources, and Unix shell
quoting was used for subprocess capture. The fixes keep Windows command quoting,
`cd /d`, compatible V8 platform headers, and clean-runner temporary directories
inside the tested workflow.

There are still deliberate limits. The native async lowering schedules a whole
async or sync callable body as one task; it does not yet turn every individual
`await` into a separate continuation boundary. Native FFI is explicit about
ownership, and the benchmark matrix is hardware- and toolchain-dependent. The
release therefore represents a stable execution and packaging path for the
covered native subset, not a claim of complete JavaScript runtime equivalence.

The durable lesson from this milestone is to share semantic decisions and make
backend-specific ownership visible at the final boundary. The compiler can
reuse analysis and source declarations across JavaScript and C++, while the
runtime, allocator, foreign library, and platform adapters each keep the
responsibilities that the other layers cannot safely infer.
