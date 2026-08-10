# Self-hosting CI should use one C++ translation unit and conservative optimization

## Symptom

The isolated compiler self-hosting runner generated a header, one C++ file per module, and a `main.cpp`, then compiled all of them with `g++ -O3`. This made the CI native build unnecessarily expensive and exposed failures to the multi-translation-unit build path.

## Root cause

`compileNativeModuleGraph` intentionally supports modular C++ output, but the self-hosting runner did not have a way to request the emitter's already-supported single-file mode. The runner also hard-coded its native optimization level independently from the normal compiler selection.

## Resolution

The CLI now exposes `cpp build --single-file`, forwarding `emitCppModuleFiles: false` while preserving modular output elsewhere. The isolated runner uses that flag for every C++ generation and links with `-O1`. Native compilation probes `clang++ --version` asynchronously and prefers Clang, falling back to `g++` when Clang is unavailable; internal compiler-error fallback remains available in the opposite direction.

## Investigation notes

- Changing the module graph's global default would have altered normal native builds and existing modular-output consumers, so the CI path uses an explicit option instead.
- A full standard test run initially hit an unrelated flaky LSP documentation assertion under load; the affected test passed in isolation, and a subsequent full run passed all 2556 tests.
- The full native suite exercised real `clang++` links successfully, but its complete CLI smoke case with `-O0` was stopped after several minutes because it is outside the CI path, which now uses `-O1`.

## Regression protection

The CLI suite verifies that `--single-file` emits only the translation unit, the native build tests verify asynchronous compiler selection, and the self-host summary test records the `clang++ -O1` CI default.
