---
layout: blog-post.njk
title: One FFI surface for Deno and native C++
date: 2026-07-22
category: Native interoperability
summary: ABI-aware annotations now generate dynamic Deno bindings and optimized native C++ calls from the same declarations.
tags: blog
permalink: /blog/cross-backend-ffi.html
---

On July 22, VexaScript gained a source-level FFI that targets both Deno and generated native C++.

`@FFILibrary` accepts an ordered list of dynamic-library candidates, allowing one declaration to cover `.dylib`, `.so`, `.dll`, and framework layouts. Static methods map to exported C symbols; `@FFIName` provides a friendlier source name when needed, while an unannotated method simply imports its own name. Deno emits `Deno.dlopen` bindings with a compatible `globalThis.VexaFFI` fallback, and native C++ emits cached `LibraryOpen` handles and symbol lookups.

The ABI model includes integer widths, numbers, booleans, UTF-8 strings, `ArrayBuffer`, pointers, and `@FFIStruct` storage. `@FFISize`, `@FFIAlign`, and `@FFIOffset` make native layouts explicit. Struct fields can live in a primary constructor or as ordinary class fields, and explicit offsets may overlap for C unions such as `SDL_Event`. Structs and buffers pass their backing bytes without copying.

Blocking functions can expose `Promise<T>`. Deno uses its nonblocking FFI path, while native C++ performs the call on a worker and resumes the main event loop when it completes.

The `samples/ffi-sdl2` example validates the complete design. It opens SDL2 dynamically, polls an overlayed event structure, queries keyboard state through an `ArrayBuffer`, moves and draws a rectangle created with named arguments, and makes `SDL_Delay` asynchronous so the game loop yields. The same source runs under Deno and as an optimized native executable.

For trusted compile-time wrappers, `@CppHeader`, `@CppFlags`, and `@CppBody` can also contribute headers, compiler/linker arguments, and direct C++ bodies when a library needs a thin static adapter.
