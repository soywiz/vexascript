import { describe, expect, it, join, readFile } from "../compiler/test/expect";
import { compileNativeModuleGraph } from "../compiler/runtime/nativeModuleGraph";
import { transpile } from "../compiler/runtime/transpile";

describe("native SDL2 sample", () => {
  it("emits its SDL2 bridge and native build flags without requiring SDL2 during tests", async () => {
    const result = await compileNativeModuleGraph(
      join(process.cwd(), "samples", "ffi-sdl2", "main.vx"),
      "optimized"
    );

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("#include <SDL2/SDL.h>");
    expect(result.code).toContain("SDL_CreateWindow(");
    expect(result.code).toContain("SDL_PollEvent(&event)");
    expect(result.nativeCompilerFlags).toEqual([
      "-I/opt/homebrew/include",
      "-L/opt/homebrew/lib",
      "-lSDL2",
    ]);
  });

  it("emits the dynamic SDL2 class for native C++ and Deno FFI", async () => {
    const sourcePath = join(process.cwd(), "samples", "ffi-sdl2", "dynamic.vx");
    const nativeResult = await compileNativeModuleGraph(sourcePath, "optimized");
    const javaScriptResult = transpile(await readFile(sourcePath, "utf8"), { sourceFilePath: sourcePath });

    expect(nativeResult.errors).toEqual([]);
    expect(nativeResult.code).toContain("vexa::LibraryOpen::symbol(");
    expect(nativeResult.code).toContain('"/opt/homebrew/lib/libSDL2.dylib"');
    expect(nativeResult.code).toContain("class __vexa_module_0_SDLEvent final");
    expect(nativeResult.code).toContain("std::int32_t& commonType;");
    expect(nativeResult.code).toContain("__vexa_module_0_SDLEvent()");
    expect(nativeResult.code).toContain("vexa::ArrayBufferObject* keyCount");
    expect(nativeResult.code).toContain("make<__vexa_module_0_SDLRect>(368, 193, 64, 64)");
    expect(nativeResult.code).toContain("vexa::runAsync(vexa::Runtime::current()");
    expect(nativeResult.code).toContain("vexa::FFIPointerObject*");
    expect(javaScriptResult.errors).toEqual([]);
    expect(javaScriptResult.code).toContain("globalThis.Deno?.dlopen");
    expect(javaScriptResult.code).toContain('CreateWindow: { name: "SDL_CreateWindow", parameters:');
    expect(javaScriptResult.code).toContain("this.buffer = new ArrayBuffer(56)");
    expect(javaScriptResult.code).toContain('GetKeyboardState: { name: "SDL_GetKeyboardState", parameters: ["buffer"]');
    expect(javaScriptResult.code).toContain("new Uint8Array(keyCount)");
    expect(javaScriptResult.code).toContain("keys.getInt8(SDL_SCANCODE_LEFT)");
    expect(javaScriptResult.code).toContain("new SDLRect(368, 193, 64, 64)");
    expect(javaScriptResult.code).toContain('Delay: { name: "SDL_Delay", parameters: ["i32"], result: "void", nonblocking: true }');
  });
});
