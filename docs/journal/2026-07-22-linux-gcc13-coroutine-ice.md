# Linux GCC 13 coroutine syntax-check ICE

## Symptom

The main GitHub Actions workflow failed for many consecutive commits even
though the complete test suite passed locally and the dedicated macOS and
Windows native jobs were green. The Linux `test` job failed in
`build --emit cpp accepts the complete TypeScript CLI` while performing the
final syntax-only check of the generated self-host translation unit.

## Evidence

Generation completed successfully. GCC 13.3 then crashed inside
`build_special_member_call` while transforming the coroutine emitted for
`LocalVfs.readDir`. The compiler printed an internal compiler error and asked
for a GCC bug report; it did not report invalid generated C++.

The same complete generated graph compiled with Apple's Clang in the local
suite, while the dedicated native macOS and MinGW Windows jobs completed. The
remaining Linux tests also exercised focused generated programs through GCC,
so removing all GCC coverage would have been unnecessary.

## Resolution

Syntax-only validation selects `clang++` on Linux and retains `g++` elsewhere.
Normal native executable builds remain on `g++`, as do the focused Linux C++
compile-and-run tests. This confines the workaround to the very large coroutine
graph that triggers the GCC 13 frontend bug without weakening runtime or linker
coverage.

A pure compiler-selection regression documents the platform choice so a future
toolchain upgrade can revisit it deliberately.
