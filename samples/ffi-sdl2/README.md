# SDL2 JavaScript FFI game loop

This sample exercises VexaScript's JavaScript FFI support through Deno.
`@FFILibrary` tries ordered DLL, shared-object, dylib, and framework candidates.
`SDLEvent` and `SDLRect` are `ArrayBuffer`-backed `@FFIStruct` classes whose
views are declared as normal fields; the event layout also demonstrates
overlapping offsets.

SDL handles use `FFIPointer`, `SDL_GetKeyboardState` demonstrates passing a raw
`ArrayBuffer` to C, and `@FFIName` keeps the source API concise while resolving
the exported SDL symbols. The `Promise<void>` return on `SDL2.Delay` marks the
blocking call as nonblocking for Deno FFI so the game loop can resume between
frames.

Run the sample with:

```sh
./vexa run -deno samples/ffi-sdl2/dynamic.vx
# Or, after installing `vexa` on PATH:
./samples/ffi-sdl2/dynamic.vx
```

The Deno run mode invokes `deno run -A`, including the FFI and filesystem
permissions required by the sample. Other JavaScript runtimes may install
`globalThis.VexaFFI` with an `open(path, symbols)` method compatible with the
`{ symbols }` shape returned by `Deno.dlopen`.
