# Native CI tests must install the VexaScript text loader

## What failed

The macOS and Windows native CI jobs failed before running their smoke tests
because Node reported `ERR_UNKNOWN_FILE_EXTENSION` for
`compiler/runtime/vexascript.d.vx`.

## Root cause

The native workflow invoked the native smoke test directly with `tsx`, but
omitted `scripts/registerTextModuleLoader.cjs`. The repository's package test
and native stress scripts already installed this loader, so local runs through
those scripts passed while the platform-specific CI commands diverged.

## Fix and regression guidance

Both native workflow commands now register the text loader before starting the
Node test runner. Any direct Node invocation that imports compiler runtime
declarations must keep the same `--import` registration; adding `tsx` alone is
not sufficient because `.vx` declaration files are intentionally loaded as
text, not executed as JavaScript.

The focused native smoke and full test suite both pass with the corrected
invocation. The test now lives at `tests/native/nativeSmoke.native.ts`; native
tests use this dedicated directory and explicit runner entrypoint so the normal
test suite does not accidentally execute the C++ toolchain workload.
