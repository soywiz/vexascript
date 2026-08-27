---
layout: blog-post.njk
title: "What's new in VexaScript 0.10.0"
date: 2026-07-25
category: Release announcement
version: 0.10.0
summary: VexaScript 0.10.0 adds native C++ compilation, broader TypeScript support, improved editor tools, self-hosting, FFI, and faster development builds.
tags: blog
permalink: /blog/vexa-0.10.0.html
---

VexaScript 0.10.0 was released on July 25, 2026. It adds a native C++ backend
while keeping the existing JavaScript and browser tools. It also expands
TypeScript compatibility and improves the CLI, LSP, Monaco editor, and test
coverage.

## **Release overview**

| Version | Date | Main changes |
| --- | --- | --- |
| 0.9.0 | 2026-06-13 | First public language, website, playground, CLI, and editor preview |
| 0.9.4 | 2026-06-26 | Last 0.9.x package before native compiler work |
| 0.10.0 | 2026-07-25 | Native C++, FFI, self-hosting, and broader TypeScript support |

The release includes work across the language, compiler, editor tools,
website, native runtime, and build system.

## **Language and TypeScript support**

VexaScript 0.10.0 supports named arguments, brace and tail lambdas, receiver
blocks, property references, annotations, `defer`, cascade and range
expressions, smart casts, enums, accessors, interfaces, modules, JSX, and richer
destructuring.

The compiler also handles more TypeScript declarations. This includes generic
constraints, tuple and readonly array types, mapped and conditional types,
`infer`, template literal types, common utility types, overloads, ambient
namespaces, and imported extension members.

Real packages are used as tests. The sample suite includes React, Preact, React
Query, Pixi, Three.js, Zod, Moment, date-fns, Minimist, and Node declarations.
When a package finds a compiler bug, the repository adds a smaller focused test
instead of changing the sample to hide the problem.

## **Editor and development server**

Hover, definition, references, rename, completion, signature help, diagnostics,
semantic tokens, inlay hints, formatting, and quick fixes now share more of the
same project analysis.

The browser version of Monaco uses the same browser-compatible compiler and
LSP code. Its virtual workspace stores editable files and runtime declarations.
The VS Code and Monaco syntax highlighters are also generated from shared syntax
data.

Repeated Pixi entry rebuilds improved from 212 ms and 201 ms to 52 ms and
45 ms. The server keeps unchanged module types, declarations, and generated
vendor code. The browser still reloads the whole page because Pixi applications
need an explicit cleanup API before safe hot-module replacement is possible.

## **CLI and self-hosting**

The CLI can build projects, create bundles and static output, emit source maps,
compile TypeScript entrypoints, report phase timings, and use native commands:

```text
vexa cpp file.vx
vexa cpp build file.vx
vexa cpp link file.vx
vexa cpp run file.vx
```

The JavaScript compiler can compile its complete TypeScript CLI graph, run the
generated compiler from an isolated directory, and repeat the process for three
stable generations.

The native compiler can also compile the compiler project and generate another
C++ compiler. These tests cover the parser, module resolver, type analysis,
code generation, runtime, and CLI together.

## **Native C++ and memory**

The C++ backend uses the same analyzed program as the JavaScript backend. It
supports classes, interfaces, operators, typed arrays and collections,
generators, asynchronous tasks, timers, Promises, bigint, modules, and native
executables.

| Runtime need | Native implementation |
| --- | --- |
| VexaScript object lifetime | Oilpan tracing garbage collector |
| Arrays | Managed `ArrayObject<T>` |
| Async work | Runtime queue and `Task<T>` |
| Generators | C++20 coroutines |
| Ordinary C++ allocation | mimalloc in release builds |
| Foreign resources | Explicit FFI pointers and buffers |

An early `std::vector<T>` array implementation was removed because it copied
arrays and could not trace object cycles correctly.

## **Foreign functions and performance**

FFI annotations describe library names, symbols, structs, pointers, buffers,
and asynchronous native calls. The JavaScript backend generates Deno FFI code,
while the C++ backend generates dynamic-library calls from the same source
declaration.

The following measurements used darwin/arm64, AppleClang, a release Oilpan
build, and JavaScript generated from the same source:

| Metric | Native | Node.js |
| --- | ---: | ---: |
| Startup median | 5.47 ms | 35.06 ms |
| Workload median | 7.82 ms | 41.25 ms |
| Array workload | 0.88 ms | 2.20 ms |
| BigInt workload | 0.08 ms | 0.04 ms |
| Event-loop workload | 0.03 ms | 1.84 ms |

The larger self-hosted compiler later measured 2.37 seconds natively and
2.15 seconds under Node.js. Native code was not faster for every workload.

Native support is still smaller than the full JavaScript runtime. Native async
code schedules a whole callable body as one task instead of turning every
`await` into a separate continuation. FFI ownership is manual. Performance
depends on the machine and toolchain.

The release validates native builds across Linux, macOS, and Windows with
different workloads. It also runs the full compiler tests, CLI fixture, website
build, and browser checks. The main design rule is to share parsing and type
analysis, then handle target-specific memory and ABI rules during code
generation.
