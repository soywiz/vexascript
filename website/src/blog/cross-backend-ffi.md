---
layout: blog-post.njk
title: Using one FFI declaration with Deno and C++
date: 2026-07-22
category: Native interoperability
summary: VexaScript FFI annotations describe native libraries, functions, structs, pointers, buffers, and asynchronous calls for both Deno and C++.
tags: blog
permalink: /blog/cross-backend-ffi.html
---

Commit `3fd7d226` added VexaScript's foreign-function interface on July 22,
2026. The same source declaration can generate Deno FFI code or native C++
calls.

## **Declaring a native library**

`@FFILibrary` lists possible library names for each operating system. The
runtime tries them in order.

```vexa
@FFILibrary(
  "SDL2.dll",
  "libSDL2.so",
  "libSDL2-2.0.so.0",
  "/Library/Frameworks/SDL2.framework/SDL2",
)
class SDL2 {
  @FFIName("SDL_Init")
  static Init(flags: int): int

  static SDL_Quit(): void
}
```

`@FFIName` maps a VexaScript method to a different C symbol. Methods without
the annotation use their own name.

| Operation | Deno | Native C++ |
| --- | --- | --- |
| Open library | `Deno.dlopen` | Platform dynamic loader |
| Find symbol | Generated Deno descriptor | Cached typed lookup |
| Call function | Deno FFI function | C++ function pointer |
| Nonblocking call | Deno nonblocking symbol | Worker task and event-loop callback |

Application code calls the same typed class on both targets.

## **Supported values**

A C API needs exact value sizes and ownership rules. It cannot rely on the
broad TypeScript `number` type.

| VexaScript value | Native value |
| --- | --- |
| `int`, `long`, or sized integer | Integer with a defined width and sign |
| `number` | Floating-point value |
| `boolean` | ABI boolean value |
| `string` | Temporary UTF-8 pointer |
| `ArrayBuffer` | Pointer to its bytes |
| `FFIPointer` | Opaque native address |
| `@FFIStruct` object | Pointer to fixed-layout storage |
| `void` | No return value |

Numeric, boolean, pointer, and void results are supported. String results and
arbitrary structs returned by value still need more ABI rules.

## **Struct layout**

`@FFIStruct`, `@FFISize`, and `@FFIOffset` define the exact layout of a C
structure.

```vexa
@FFIStruct
@FFISize(16)
class SDLRect(
  @FFIOffset(0) x: int = 0,
  @FFIOffset(4) y: int = 0,
  @FFIOffset(8) width: int = 0,
  @FFIOffset(12) height: int = 0,
)
```

Each instance uses an `ArrayBuffer`. Deno can pass the bytes directly, and C++
can use the same layout. Offsets may overlap for C unions such as `SDL_Event`.

The native `DataView` uses `std::memcpy` for fixed-width reads and writes. This
works with unaligned buffers and avoids C++ aliasing problems. Optimizing C++
compilers turn these fixed-size copies into direct loads and stores.

## **Asynchronous native calls**

A foreign method that returns `Promise<T>` is treated as nonblocking. Deno marks
the symbol as nonblocking. Native C++ runs the function on a worker and resumes
the Promise on the main event loop.

Arguments sent to the worker must remain valid for the whole call. The native
runtime copies plain data and does not leave untracked pointers to managed
objects on the worker thread.

## **SDL2 sample and C++ helpers**

The SDL2 sample opens a window, reads an overlaid event struct, passes buffers,
moves a rectangle from keyboard input, waits asynchronously, and releases its
resources. It ran for 600 frames under Deno and native C++ with SDL's dummy
video driver.

Target-specific bindings can also use `@CppHeader`, `@CppFlags`, and
`@CppBody`. These annotations are separate from the portable FFI API so a C++
helper is not presented as if it also worked in Deno.

The current design keeps library names, symbol names, value layouts, and
ownership rules in source code. It does not hide differences that matter for
memory safety or platform compatibility.
