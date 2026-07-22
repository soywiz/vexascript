# Native bindings need one declaration surface across C++ and JavaScript

## Symptom

Calling a small native library previously required editing generated C++ or
adding a one-off runtime primitive. There was no source-level way to contribute
a header, linker arguments, or a raw implementation body, and no declaration
that could represent the same dynamic library in native C++ and Deno.

## Investigation

Compiler flags cannot safely be encoded into generated C++ comments and parsed
back later. The native module graph already owns the set of reachable source
modules, so it is the durable boundary for collecting build metadata. Keeping
each flag as a separate string also avoids shell parsing and preserves paths that
contain spaces.

Dynamic libraries presented a second unification problem. Platform-specific
fields would force the compiler to choose one path too early and would not cover
versioned shared objects or framework installations. An ordered candidate list
works in every backend: each runtime tries paths until one opens.

The annotation declaration parser initially reused class-primary-constructor
parameters, which cannot express a rest parameter. Rather than fixing
`FFILibrary` to an arbitrary maximum number of paths, annotation declarations
now accept a function-style rest parameter and semantic argument validation
checks every extra argument against its element type.

## Resolution

`@CppHeader`, repeated `@CppFlags`, and `@CppBody` now describe trusted native
function bindings. Reachable native modules contribute deduplicated headers and
flags; the executable path passes flags directly to `g++`, and the C++ emitter
uses the analyzed function signature around the raw body.

`@FFILibrary("candidate", ...)` now annotates an ambient class with static C
symbols. Generated C++ uses a cached `LibraryOpen` handle plus one cached symbol
per method. Generated JavaScript lazily tries the same candidates through
`Deno.dlopen`, falling back to a compatible `globalThis.VexaFFI.open` adapter.
`@FFIName` is one shared symbol-name override; without it both emitters use the
source method name.
The first end-to-end smoke calls the C runtime's `abs` through a deliberately
missing first candidate, proving fallback, worker-thread invocation, main-loop
resumption, and symbol invocation. The same smoke allocates native memory and
validates arbitrary `FFIPointer` reads and writes.

FFI-focused samples use a `samples/ffi-*` prefix so native-library dependencies
remain visibly separate from normal JavaScript samples. The
`samples/ffi-sdl2/` sample validates both designs. Its direct binding uses a
header, flags, and raw wrapper bodies. Its dynamic version opens the installed
SDL2 dylib through generated native C++ and Deno FFI, stores `SDL_Event` and
`SDL_Rect` in validated `@FFIStruct` buffers, renders a moving rectangle, and
declares `SDL_Delay` as `Promise<void>` so the blocking call runs off the main
event loop.

The ABI supports integer, 64-bit integer, double, boolean, UTF-8 string,
`ArrayBuffer`, `@FFIStruct`, and `FFIPointer` parameters plus
numeric/boolean/pointer/void results. Struct and buffer parameters pass their
backing bytes without copying. Deno does not expose arbitrary pointer writes
directly, so the generated adapter deliberately uses the platform C runtime's
`memcpy`; this was verified against real allocated memory. String results and
by-value aggregate results remain explicit future extensions rather than being
guessed unsafely.

The first struct layout only considered primary-constructor parameters and
rejected every overlap. That was too narrow for real C ABIs: `SDL_Event` is an
overlay, while many C structs are more readable as field declarations. The
layout source now unifies constructor parameters and ordinary instance fields;
explicit offsets can overlap, automatic placement remains monotonic, and
constructor defaults retain normal call-site semantics. The SDL sample keeps
`SDL_Rect` ergonomic with defaulted constructor fields and named arguments, but
uses ordinary overlapping fields for `SDL_Event`. Its keyboard query also turns
the previously emission-only `ArrayBuffer` mapping into an end-to-end native
ABI test through `memset`.

`DataViewObject` initially reconstructed every 16/32/64-bit value one byte at a
time. Replacing that loop with a direct typed-pointer dereference looked simpler
but would be undefined for valid unaligned DataView offsets and could violate
C++ aliasing rules. Fixed-size `std::memcpy` is the portable unaligned-load/store
idiom and is folded into native-width instructions by optimizing compilers. The
runtime now performs one fixed-width transfer and compares the requested byte
order with `std::endian::native`, applying one integer byte swap only when they
differ.
