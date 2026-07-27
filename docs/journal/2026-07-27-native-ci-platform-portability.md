# Native CI exposed platform adapter gaps

The text-module loader fix made the native CI jobs reach the next layer of
failures. Linux then hit a GCC 13 internal compiler error while compiling the
generated coroutine-heavy translation unit, Windows rejected absolute
TypeScript entry paths passed through `tsx`, and Windows could not spawn the
`pnpm` shell shim by its Unix name. The macOS native smoke also exposed a
failure in the clean native self-host/Pixi path.

The fixes keep the platform decisions at the existing adapter boundaries:

- Native compilation uses `g++` on every platform. Linux syntax validation uses
  `clang++`, and a Linux executable compile retries with Clang only when GCC
  reports its known internal compiler error; this preserves GCC runtime
  compatibility for ordinary native binaries.
- Native smoke launches use repository-relative module paths, which avoids
  `tsx` treating a Windows drive path as an invalid URL.
- Node-side package-manager invocations select `pnpm.cmd` on Windows.
- The native `Process` binding exposes `platform`, native environment-variable
  lookup returns an ordinary string, and native build helpers select temporary
  directories, CMake generators, compiler flags, and system libraries by
  platform.
- Native self-hosted bundling keeps pnpm's virtual-store resolution enabled;
  disabling it made clean CI installs leave Pixi's `@pixi/*` dependency map
  entries as `null`.

The first investigation branch tried to represent the native process platform
as a persistent string object. The generated C++ then compared that persistent
handle with a UTF-16 string and failed to compile. A plain runtime `Value`
preserves the generated property contract without introducing a special
comparison path. The complete test suite, native smoke suite, and CLI fixture
validation now pass locally.
