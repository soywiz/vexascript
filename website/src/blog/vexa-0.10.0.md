---
layout: blog-post.njk
title: "From VexaScript 0.9.0 to 0.10.0: one language, two backends, a tested toolchain"
date: 2026-07-25
category: Release announcement
version: 0.10.0
summary: A technical account of what changed between VexaScript's first public release and 0.10.0 across the language, TypeScript compatibility, LSP, website, CLI, native C++, FFI, and release validation.
tags: blog
permalink: /blog/vexa-0.10.0.html
---

VexaScript 0.9.0 was the first public release: a concise TypeScript-derived
language with a browser playground, embeddable Monaco editors, a CLI, and
editor tooling. Version 0.10.0, released from commit `3ef03875` on
2026-07-25, keeps that JavaScript and browser foundation but adds a second
execution backend, a much broader TypeScript compatibility boundary, and a
native build workflow that is exercised as part of the repository's tests.

The history between the two milestones contains 344 non-merge commits. That
number is a count of repository history, not a quality metric; it is useful
context because the release is the result of several connected lines of work
rather than one isolated feature.

| Milestone | Date | Repository marker | Scope |
| --- | --- | --- | --- |
| 0.9.0 | 2026-06-13 | `0269ea78` | First public language, website, playground, CLI, and editor preview |
| 0.9.4 | 2026-06-26 | `59d87d40` | Last 0.9.x package before the native and self-hosting work |
| 0.10.0 | 2026-07-25 | `3ef03875` | Shared front end, JavaScript output, native C++ output, FFI, and release validation |

## **The language grew without abandoning TypeScript**

The 0.9.0 release established VexaScript's compact surface: `val` and `fun`,
primary-constructor classes, `sync` functions, delegated variables, operator
overloading, optional `this`, and class calls without `new`. By 0.10.0, the
syntax reference also covers named arguments, tail and brace lambdas, receiver
function types, postfix receiver blocks, property references, annotations,
`defer`, cascade expressions, range expressions, smart casts, enums, accessors,
interfaces, module exports, runtime namespaces, embedded JSX, and richer
destructuring.

Several of these features are deliberately implemented as one semantic path
with backend-specific emission. A `sync` function uses the analyzer's
auto-await decisions; the JavaScript emitter and the native emitter consume
that result instead of independently rediscovering Promise expressions. A
postfix receiver block evaluates its receiver once and returns the same value;
it does not become a separate `apply`-style runtime feature. Property references
reuse member resolution and lower to the same value-object delegate shape used
by delegated variables.

The language also gained more precise operator and type behavior. The
three-way comparison operator (`<=>`) can derive the ordinary comparison
operators, `!=` can derive from `==`, extension methods and properties carry
generic receiver arguments, and `int`, `long`, and `bigint` remain distinct
through analysis and native emission. These changes matter because syntax
support alone is not enough: the same construct must have a stable type,
diagnostic, completion, formatting, and runtime story.

## **TypeScript and npm ecosystem coverage became a first-class boundary**

The first release promised TypeScript interoperability. The work leading to
0.10.0 made that promise testable against real declaration graphs rather than
only small hand-written examples. The compiler now handles more generic calls,
generic constraints, contextual inference, tuple and readonly array forms,
mapped and conditional aliases, `infer`, template literal types, common utility
aliases, `keyof`/`typeof`/indexed access forms, constructor and assertion
signatures, enums, ambient namespaces, overloads, and imported extension
members.

The module graph now carries imported declaration origins through analysis and
LSP navigation. Node package exports, `baseUrl`, namespace imports, re-exported
bindings, local module graphs, JavaScript/ESM dependencies, and TypeScript
declaration files share the same resolution infrastructure. The CLI can bundle
VexaScript, JavaScript, and selected `node_modules` dependencies, while a
TypeScript entrypoint can be checked and emitted through the same public
workflow.

The ecosystem samples were used as compatibility probes, not as sample-side
workarounds. The repository now exercises libraries and application shapes
including React, Preact, React Query, Pixi, Three.js, Zod, Moment, date-fns,
Minimist, and Node declarations. When a sample exposed an imported generic or
LSP regression, the fix was reduced to a focused compiler test and the real
sample stayed representative of user code. Some probes, such as RxJS and
Hono, remain documented as deeper compatibility work rather than being kept as
half-working claims of support.

## **The LSP, Monaco, and website now use the same project model**

In 0.9.0, editor tooling was already part of the public experience. During the
0.9.x cycle, the implementation was reorganized around shared analysis
sessions, declaration origins, cursor targets, imported-symbol resolution, and
cross-file context. Hover, go-to-definition, references, rename, completion,
signature help, diagnostics, semantic tokens, inlay hints, formatting, and
quick fixes now consume common resolution paths wherever their semantics
overlap. This avoids a fix being visible in one editor feature while an
equivalent navigation or completion request still follows an older path.

The website's Monaco embed moved toward the same browser-compatible compiler
and LSP infrastructure. Its virtual workspace can hold editable files and
runtime declarations, the language worker runs analysis in the browser, and
session caches reuse imported project state across repeated hover and
definition requests. The website highlighter now derives its token families
from the shared portable Monarch description; the VS Code grammar and Monaco
targets are checked against the same source.

The development server also became measurably more incremental. On the Pixi
sample, steady-state entry rebuilds fell from observed 212 ms and 201 ms to
52 ms and 45 ms after the serve session began retaining stable module typing,
declaration, emitter, and vendor-bundle state. The browser still performs a
full page reload: replacing a running Pixi application safely requires an
explicit disposal and ownership contract, so claiming HMR would be inaccurate.

## **The CLI and self-hosting now cover the whole compiler graph**

The 0.9.0 CLI offered direct execution, JavaScript builds, tests, formatting,
syntax inspection, and an LSP entrypoint. The current CLI adds project-aware
bundling, static site output, source maps, TypeScript entrypoints, phase timing,
and a unified native command group:

```text
vexa cpp file.vx
vexa cpp build file.vx
vexa cpp link file.vx
vexa cpp run file.vx
```

`cpp link` and `cpp run` cache the generated translation unit and executable
using source versions, compiler options, native flags, and project
configuration as invalidation inputs. The cache is a CLI adapter around the
shared compiler pipeline, not a second parser or type checker.

The JavaScript compiler also became self-hosting in a concrete sense. The
complete `cli/cli-bin.ts` graph can be bundled into a standalone Node CLI,
executed from an isolated output directory, used to compile the same graph
again, and compared across three generations. That work exposed false-positive
TypeScript diagnostics, `baseUrl` and dotted-filename resolution errors, and
browser-versus-Node external boundaries. The fixes kept TypeScript's own
semantic check authoritative where appropriate instead of weakening the
browser compiler with Node-only dependencies.

The native path then extended the same proof. A generated C++ compiler can load
the compiler project, perform semantic analysis, emit another C++ translation
unit, and participate in byte-stable roundtrips. This is stronger than a small
native hello-world sample because it exercises the parser, declarations, module
graph, type system, emitter, runtime, and CLI together.

## **Native C++ adds a second execution backend**

The C++ backend began with a small Oilpan example in commit `a380895e` on
2026-07-16. It now consumes the same analyzed program as JavaScript emission
and supports a growing native subset: classes, interfaces, operator overloads,
typed arrays and collections, generators, async tasks, timers, Promise
facades, arbitrary-precision bigint, smart casts, modules, TypeScript inputs,
and native executable packaging.

The key representation decisions are visible in the runtime boundary:

| VexaScript concern | Native representation in 0.10.0 | Why it is shared or explicit |
| --- | --- | --- |
| Language object graph | Oilpan-managed objects and traced members | Cycles and reachability need tracing rather than reference counting |
| Arrays | `ArrayObject<T>` with traced or stored slots | Preserves identity and keeps managed elements in the GC graph |
| Async work | One `Runtime` queue and `Task<T>` state | Avoids a second scheduler with different ordering rules |
| Generators | One C++20 coroutine implementation | Sync and async-capable iteration share suspension and conversion logic |
| Ordinary native allocation | mimalloc in release builds | Handles C/C++ allocation separately from language reachability |
| Foreign resources | Explicit FFI pointers, buffers, and release contracts | External ownership cannot be inferred safely by Oilpan |

An early `std::vector<T>` array mapping was rejected because copying a vector
changed source-level identity and left managed object elements outside Oilpan's
traced graph. A separate native Promise implementation was also rejected in
favor of the same settlement state used by async functions. These are examples
of the release's general design rule: preserve source semantics once, then make
the unavoidable ownership and ABI decisions at the backend boundary.

## **One FFI declaration can target Deno and C++**

Version 0.10.0 adds source-level annotations for foreign libraries, headers,
linker flags, raw native bodies, symbol names, structs, pointers, buffers, and
asynchronous calls. A typed ambient class can describe one API while the
JavaScript emitter produces a Deno FFI adapter and the native emitter produces
cached dynamic-library calls. The SDL2 sample exercises typed foreign structs,
callbacks, pointer-like handles, and a dynamic binding path.

The shared declaration does not pretend that the two runtimes have identical
ownership. Native pointers are not silently Oilpan objects, external buffers
have explicit validity windows, and library candidates are tried in declaration
order. This keeps the source-facing API unified while leaving allocation,
release, ABI layout, and platform library naming visible to the person writing
the binding.

## **Measurements, portability, and limits define the release boundary**

The following benchmark rows were measured on 2026-07-22 on darwin/arm64 with
AppleClang through `/usr/bin/g++`, a release Oilpan build, and Node.js running
JavaScript emitted from the same source:

| Metric | Native | Node | Native speedup |
| --- | ---: | ---: | ---: |
| Startup median | 5.47 ms | 35.06 ms | 6.41x |
| Workload median | 7.82 ms | 41.25 ms | 5.28x |
| Array workload | 0.88 ms | 2.20 ms | 2.50x |
| Bigint workload | 0.08 ms | 0.04 ms | 0.50x |
| Event-loop workload | 0.03 ms | 1.84 ms | 61.33x |

The native workload binary was 821,336 bytes, and fresh generation, compilation,
and linking took 2,875.72 ms. The larger self-hosted command,
`cpp cli/cli.ts --target optimized`, reached a 2.37-second warm median versus
2.15 seconds for the matching Node CLI on that machine. These measurements
establish a working native path and selected runtime wins; they do not establish
that every VexaScript program or the native compiler itself is faster than Node.

Portability became part of the acceptance boundary rather than an afterthought.
The native packaging checks cover macOS, Linux, and Windows paths. Windows
validation found drive-rooted path handling errors, incompatible vendored V8
header revisions, Unix-only command quoting, and temporary-directory
assumptions. The fixes added Windows command quoting and `cd /d`, compatible
platform headers, clean-runner temporary paths, and line-ending-normalized
packaging assertions. GCC 13 coroutine ICEs are avoided by using Clang for
syntax-only validation while retaining GCC coverage where it is authoritative.

The 0.10.0 boundary is intentionally explicit. Native async lowering schedules
an entire async or sync callable body as one task; it does not yet turn every
individual `await` into a continuation boundary. FFI ownership remains manual,
the benchmark matrix depends on hardware and toolchain, and native support is
still a subset rather than complete JavaScript runtime equivalence. The current
repository validation closes with 2,404 passing tests across 269 suites, plus
the CLI fixture smoke test and website/browser checks.

The durable lesson from the transition is that a language milestone is more
than a list of syntax additions. VexaScript 0.10.0 is credible because the
same source-level decisions feed the JavaScript compiler, native compiler, LSP,
browser workspace, CLI, samples, and tests; where the backends must differ,
their memory, ABI, platform, and runtime responsibilities are documented
instead of hidden behind parallel implementations.
