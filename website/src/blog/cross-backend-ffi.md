---
layout: blog-post.njk
title: One FFI surface for Deno and native C++
date: 2026-07-22
category: Native interoperability
summary: ABI annotations generate Deno dlopen bindings and native C++ calls from one declaration, including layouts, pointers, buffers, and asynchronous calls.
tags: blog
permalink: /blog/cross-backend-ffi.html
---

Commit `3fd7d226`, dated July 22, 2026, added a foreign-function interface that is compiled from the same VexaScript declarations for Deno and native C++. The change touched 41 files, with 2,007 insertions and 88 deletions, because an FFI is not only a symbol lookup API. It must describe platform library names, exact ABI values, memory ownership, aggregate layout, asynchronous execution, and the differences between a managed JavaScript runtime and generated C++.

The design uses compile-time annotations as the source of truth. The compiler is free to emit a `Deno.dlopen` symbol table for JavaScript or direct cached dynamic-library calls for C++, while application code continues to call the same typed class.

## **A declaration describes the foreign boundary**

`@FFILibrary` accepts several candidate paths because a useful binding must cover `.dll`, `.so`, `.dylib`, and macOS framework layouts. Candidates are tried in declaration order. This is the source-level model:

```ts
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

`@FFIName` is optional. `Init` maps to `SDL_Init`; `SDL_Quit` imports a symbol with its own source name. This avoids requiring C naming conventions throughout application code without creating a second handwritten mapping file.

The two backends lower that declaration differently:

| Concern | Deno output | Native C++ output |
|---|---|---|
| Library open | `Deno.dlopen` with ordered candidates | cached `LibraryOpen` handle |
| Symbol resolution | generated Deno symbol descriptor | typed lookup from the cached handle |
| Call | Deno FFI function | native function-pointer call |
| Nonblocking call | Deno nonblocking symbol | worker execution, main-loop continuation |
| Fallback | `globalThis.VexaFFI` adapter | platform dynamic-loader implementation |

Library lookup and ABI lowering live behind one compiler model. Supporting another JavaScript FFI host therefore does not require changing every annotated application class.

## **ABI types are narrower than language types**

A foreign call cannot rely on TypeScript's broad `number` model or a C compiler's platform-dependent guess. The current surface supports the values needed by practical C APIs while rejecting unsupported boundaries explicitly.

| VexaScript boundary value | Foreign representation |
|---|---|
| sized integer / `int` / `long` | annotated integer width and signedness |
| `number` | floating-point ABI value |
| `boolean` | ABI boolean conversion |
| `string` | UTF-8 pointer for the duration of the call |
| `ArrayBuffer` | pointer to contiguous backing bytes |
| `FFIPointer` | opaque address with explicit reads, writes, and offsets |
| `@FFIStruct` instance | pointer to layout-controlled backing storage |
| `void` | no result |

Numeric, boolean, pointer, and void results are implemented. String results and arbitrary aggregates returned by value remain boundaries to model deliberately rather than pretending every C ABI treats them identically.

Passing `ArrayBuffer` is important because many C libraries operate on pixels, audio frames, packets, or caller-owned output storage. Both backends pass the backing block rather than converting each element. `FFIPointer` covers APIs that return or traverse native memory and provides arbitrary typed reads and writes without converting the pointer into a managed object reference.

## **Struct annotations make layout executable metadata**

`@FFIStruct`, `@FFISize`, `@FFIAlign`, and `@FFIOffset` define storage at compile time. Fields may appear as primary-constructor parameters or ordinary class fields. Constructor defaults make value construction ergonomic, while field declarations permit unions and externally populated structures that do not belong in a constructor.

```ts
@FFIStruct
@FFISize(16)
class SDLRect(
    @FFIOffset(0) x: int = 0,
    @FFIOffset(4) y: int = 0,
    @FFIOffset(8) width: int = 0,
    @FFIOffset(12) height: int = 0,
)

const player = SDLRect(x: 368, y: 193, width: 64, height: 64)
```

Every instance is backed by an `ArrayBuffer`. That gives Deno a contiguous block suitable for FFI and gives C++ a layout-compatible address. Explicit offsets may overlap, which is required for C unions such as `SDL_Event`: several event views occupy the same bytes, and a leading type field determines which view is active.

The native `DataView` implementation performs fixed-width loads and stores using `std::memcpy`, followed by an endian swap only when host and requested byte order differ. `memcpy` is not used as a slow byte loop here. For constant sizes such as 16 or 32 bits, optimizing compilers recognize it as an unaligned-safe load or store and keep values in registers when possible. Directly dereferencing a cast `int*` would impose alignment and strict-aliasing requirements that an arbitrary byte buffer cannot guarantee.

## **A Promise changes the scheduling contract**

Annotating a blocking foreign function with a `Promise<T>` return is a compile-time request to move the call off the main event loop. Deno marks the generated FFI symbol nonblocking. Native output queues the call to a worker and resumes the coroutine on the main event loop after completion.

This is more constrained than wrapping a synchronous call in syntax. Arguments crossing the worker boundary must have stable ownership, and managed native objects cannot be casually retained as raw pointers while the garbage collector proceeds. The compiler/runtime boundary therefore copies or roots the required call state and posts only the completion back to the main thread.

For SDL2, `SDL_Delay` is exposed asynchronously. The game loop can await the delay without blocking other scheduled work, then continue polling and rendering on the main thread where SDL expects it.

## **The SDL2 sample tests interaction, not only linking**

`samples/ffi-sdl2` exercises the complete surface under both Deno and an optimized native executable. It:

- opens SDL2 from platform-specific candidates;
- initializes and creates a window and renderer;
- polls an overlaid `SDL_Event` structure;
- passes an `ArrayBuffer` to keyboard-state access;
- creates `SDLRect` with named arguments and defaultable constructor fields;
- moves the rectangle from keyboard state and renders each frame;
- awaits `SDL_Delay` so the main loop yields;
- shuts down resources deterministically.

The sample was executed under Deno and natively with SDL's dummy video driver for 600 frames. That validates dynamic lookup, struct offsets, buffer transfer, the asynchronous continuation, and cleanup without depending on a visible desktop in automated tests.

## **Direct C++ escape hatches remain explicit**

Some bindings need a thin compile-time adapter rather than dynamic lookup. `@CppHeader` contributes arbitrary header text when the declaration is referenced, repeated `@CppFlags` contribute include and linker arguments, and `@CppBody` supplies the native function body. Unreferenced declarations contribute nothing, so a wrapper does not silently alter unrelated builds.

These annotations are deliberately separate from `@FFILibrary`. FFI describes a portable dynamic ABI that can target Deno and C++; C++ bodies describe trusted target-specific source. Keeping the distinction visible prevents a native convenience wrapper from appearing portable when it is not.

The useful result is not merely that SDL2 opens. The compiler now has explicit, inspectable metadata for foreign memory and calls, and it can lower that metadata according to the runtime while keeping one application-facing API.
