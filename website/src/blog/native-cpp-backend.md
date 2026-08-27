---
layout: blog-post.njk
title: How VexaScript compiles to native C++
date: 2026-07-16
category: Native compilation
summary: The C++ backend reuses the VexaScript parser and type checker, then generates native code with explicit rules for values, objects, arrays, and memory.
tags: blog
permalink: /blog/native-cpp-backend.html
---

VexaScript added its first C++ backend in commit `a380895e` on July 16,
2026. The goal was to generate native programs without creating a second
parser or type checker.

## **Shared compiler stages**

JavaScript and C++ use the same parser, syntax tree, type analysis, diagnostics,
and common compiler transformations. They differ only when the compiler starts
generating target code.

| Compiler stage | Shared work | C++-specific work |
| --- | --- | --- |
| Parsing | Build the syntax tree | None |
| Type analysis | Resolve names, types, operators, and errors | Choose a native storage type from the result |
| Modules | Find source files and imports | Collect native headers and linker flags |
| Code generation | Select a backend | Generate C++20 |
| Build | None | Run CMake, the C++ compiler, and the linker |

This split also keeps the compiler available in the browser. Shared compiler
files cannot use Node.js filesystem or process APIs because Monaco uses the
same code. Native build commands live in the CLI instead.

## **Native value types**

The C++ backend cannot map every VexaScript value to a plain C++ value.
JavaScript-style object identity, garbage collection, dynamic values, and
Promises need runtime support.

| VexaScript value | C++ representation |
| --- | --- |
| `int` | `std::int32_t` |
| `long` | `std::int64_t` |
| `number` | `double` |
| `bigint` | Runtime `BigInt` |
| Class instance | Oilpan-managed class pointer |
| Field that points to an object | `cppgc::Member<T>` |
| Array | Managed `ArrayObject<T>*` |
| Unknown value | Tagged runtime `Value` |
| `Promise<T>` | Native task and event-loop state |

The first array implementation used `std::vector<T>`. It was removed because
assignment copied the array, unlike JavaScript. It also could not safely track
cycles between arrays and managed objects. `ArrayObject<T>` keeps one shared
array object and traces object elements for the garbage collector.

## **Why the backend uses Oilpan**

VexaScript programs can create cycles. For example, an object can contain an
array that points back to the same object. Reference counting with
`std::shared_ptr` cannot collect that cycle unless the compiler also decides
which references must be weak.

Oilpan traces the object graph instead. Generated classes report their managed
fields, and the collector removes objects that can no longer be reached.

This requires clear rules. Managed fields must use traced references. Values
that survive an asynchronous pause must stay rooted. Raw data such as bytes
does not need tracing. Focused tests cover each of these cases.

## **CLI commands and generated files**

```text
vexa cpp program.vx -o program.cpp
vexa cpp link program.vx -o program
vexa cpp run program.vx
```

`cpp` generates a C++ file. `cpp link` also compiles and links it. `cpp run`
builds the program and starts it. Generated build files and cached dependencies
stay outside the source tree.

The first backend change touched 20 files and added 1,150 lines. It used C++20
and standalone Oilpan. Native support was still a subset of the language, but
it proved that VexaScript could add another backend while keeping parsing and
type analysis shared.
