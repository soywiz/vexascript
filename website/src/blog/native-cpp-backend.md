---
layout: blog-post.njk
title: VexaScript gains a native C++ backend
date: 2026-07-16
category: Native compilation
summary: How the C++ backend reuses the TypeScript/VexaScript front end, maps managed language semantics onto C++20, and keeps toolchain work outside browser-compatible compiler code.
tags: blog
permalink: /blog/native-cpp-backend.html
---

The first native backend landed in commit `a380895e` on July 16, 2026. The useful engineering question was not whether VexaScript could print a small `.cpp` file; it was where a second backend should attach so that parsing, analysis, diagnostics, lowering, and editor behavior did not split into JavaScript and C++ implementations.

## **One front end, two terminal emitters**

The C++ backend consumes the same analyzed program used by JavaScript emission. Node-only work begins only after the browser-compatible compiler has produced a translation unit.

| Layer | Shared by JavaScript and C++ | Native-only responsibility |
| --- | --- | --- |
| Parsing | AST and source-language mode | None |
| Semantic analysis | Binding, inferred types, diagnostics, operator resolution | Native representation selection consumes the results |
| Lowering | Range loops and language constructs with backend-neutral semantics | C++ renders the lowered form |
| Module graph | Source discovery, imports, project declarations | Reachable native headers/flags and translation-unit assembly |
| Emission | Backend selection at the final stage | `cppEmitter.ts` generates C++20 |
| Toolchain | None inside shared compiler modules | CLI extracts dependencies, runs CMake/`g++`, and links |

This boundary follows a practical browser constraint: compiler modules are used by Monaco and cannot depend on `node:fs`, child processes, or host toolchains. Oilpan extraction, native cache directories, compiler invocation, and linker flags therefore live in `cli/nativeBuild.ts`, while `compiler/runtime/cppEmitter.ts` remains usable in the browser build.

## **The initial language-to-C++ mapping**

JavaScript semantics cannot be reproduced by replacing every type with the closest C++ value type. Identity, garbage-collected cycles, dynamic values, and async continuations all affect the representation.

| VexaScript concept | Native representation | Reason |
| --- | --- | --- |
| `int` | `std::int32_t` | Preserve 32-bit integer behavior |
| `long` | `std::int64_t` | Preserve fixed-width signed integer behavior |
| `number` | `double` | Match JavaScript numeric operations where statically numeric |
| `bigint` | Runtime `BigInt` | Avoid truncating arbitrary precision to `long long` |
| Class instance | Oilpan-allocated generated class pointer | Preserve identity and traced object relationships |
| Class field referencing an object | `cppgc::Member<T>` | Make the edge visible to the collector |
| Temporary object surviving suspension | `cppgc::Persistent<T>` | Root the value outside an ordinary traced owner |
| Array | Managed `ArrayObject<T>*` | Preserve reference semantics and trace object elements |
| Unknown/dynamic value | Runtime `Value` | Retain JavaScript-like tagged behavior only where analysis cannot specialize |
| `Promise<T>` | Native task/event-loop machinery | Suspend without blocking the main runtime loop |

The array decision is illustrative. An early `std::vector<T>` mapping looked efficient, but assignment and parameter passing copied storage, unlike JavaScript arrays. It also could not safely represent cycles between generated objects and arrays of generated objects. `ArrayObject<T>` instead owns one traced backing object; typed primitives remain unboxed, while object elements become collector-visible edges.

## **Why Oilpan was selected instead of pervasive smart pointers**

Generated language programs can contain cycles naturally: an object owns an array, the array contains the object, and a closure captures both. `shared_ptr` would either leak those cycles or require weak-edge analysis throughout emission. Manual ownership would push lifetime logic into every generated call and suspension point.

Oilpan's standalone `cppgc` model lets generated classes declare their traceable fields and lets the runtime own allocation through `Runtime::make<T>`. The cost is discipline: every managed edge must be a `Member`, values crossing suspension need roots, and collector safe points must be placed where the runtime can tolerate collection. A separate article covers how Oilpan and mimalloc divide the native memory workload.

## **Compiler/runtime contracts discovered immediately**

| Problem discovered by the first samples | Incorrect shortcut | Durable contract |
| --- | --- | --- |
| Range iterator type | Always declare the loop variable as `double` | Read the analyzed `int`/`long`/`number` type from the shared analysis map |
| Class construction | Emit an ordinary C++ constructor call | Allocate via the active runtime so the object enters the managed heap |
| Method call allocation | Assume a global allocator is always visible | Pass a hidden `Runtime&` through generated callables |
| Array assignment | Use C++ vector value semantics | Use one managed backing object with reference identity |
| Object elements in arrays | Store raw pointers in an untraced container | Select traced or primitive slots from the analyzed element type |
| Promise completion | Keep worker-visible managed pointers | Copy plain data across worker boundaries and resume on the runtime loop |

These contracts were encoded in focused emitter tests and in runnable native samples. The broad sample is valuable only because smaller regressions protect the individual mapping decisions.

## **Public commands and artifact ownership**

```text
vexa cpp program.vx -o program.cpp
vexa executable program.vx -o program
```

`cpp` stops after generating the translation unit. `executable` keeps the generated `main.cpp` under a source-specific build directory, builds cached native dependencies under the OS temporary directory, and links the requested output. The source tree should not accumulate CMake caches or dependency objects.

| Initial milestone fact | Value |
| --- | --- |
| Commit | `a380895e` — `Initial c++ -> native example` |
| Date | 2026-07-16 11:36 +02:00 |
| Change size | 20 files, 1,150 insertions, 14 deletions |
| C++ standard | C++20 |
| Managed runtime | Standalone Oilpan / `cppgc` |
| First public surfaces | `cpp`, `executable`, native runtime docs and samples |

The backend became maintainable because it did not create a second interpretation of VexaScript. A parser fix, a type-resolution fix, or a lowering fix remains shared; the C++ emitter is responsible for representation and execution, not for rediscovering the language.
