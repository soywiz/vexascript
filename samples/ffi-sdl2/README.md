# SDL2 FFI window and game loop

Samples prefixed with `ffi-` exercise native-library integration rather than a
normal JavaScript-only runtime. This directory contains two SDL2 bindings.

`main.vx` is native-only and demonstrates trusted `@CppHeader`, repeated
`@CppFlags`, and `@CppBody` bindings:

```sh
./vexa executable samples/ffi-sdl2/main.vx --out /tmp/sdl2-window
/tmp/sdl2-window
```

`dynamic.vx` uses the cross-backend FFI surface. `@FFILibrary` tries ordered
DLL, shared-object, dylib, and framework candidates. `SDL_Event` and `SDL_Rect`
are `ArrayBuffer`-backed `@FFIStruct` classes whose views are declared as normal
class fields; the event layout also demonstrates overlapping offsets. SDL
handles use `FFIPointer`, `SDL_GetKeyboardState` demonstrates passing a raw
`ArrayBuffer` to C, and the arrow keys move the rectangle. `SDLRect` keeps
defaulted constructor fields and is created with named arguments. In addition,
`@FFIName` keeps the source API concise (`SDL2.Init`) while resolving the real
symbol (`SDL_Init`). The `Promise<void>` return on `SDL2.Delay` moves the
blocking `SDL_Delay` call to a worker so
the main event loop resumes between frames. The sample polls window events and
renders an interactive rectangle:

```sh
./vexa executable samples/ffi-sdl2/dynamic.vx --out /tmp/sdl2-dynamic
/tmp/sdl2-dynamic

./vexa build samples/ffi-sdl2/dynamic.vx --out /tmp/sdl2-dynamic.js
deno run --allow-ffi /tmp/sdl2-dynamic.js
```

Other JavaScript runtimes may install `globalThis.VexaFFI` with an `open(path,
symbols)` method compatible with the `{ symbols }` shape returned by
`Deno.dlopen`.
