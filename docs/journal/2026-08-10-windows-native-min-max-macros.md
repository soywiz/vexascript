# Windows native builds must disable `min` and `max` macros

## Symptom

The Windows native smoke job failed while compiling generated C++ with MinGW
and the Windows 2025 runner image. The compiler reported errors at valid uses
of `std::min`, `std::max`, and `std::numeric_limits<>::max()` in `native/`.

## Investigation

The native dependency build completed successfully, so the failure was not a
MinGW, CMake, Oilpan, or mimalloc build failure. The job log showed
`minwindef.h` expanding the Windows `min` and `max` macros inside the VexaScript
runtime. That explained both the qualified algorithm calls and the
single-argument `numeric_limits<>::max()` failures. Changing the runtime
expressions would have scattered Windows workarounds through portable C++.

## Resolution

Both native compiler entrypoints now pass `-DNOMINMAX` on Windows. The CLI path
used by the CI smoke test and the generated native CLI path therefore share the
same preprocessor contract. The Windows compiler-argument regression test
ensures the define remains present.

The earlier warning-only leads about deprecated CRT functions and unsupported
visibility attributes were unrelated: they did not stop compilation, while
the fatal diagnostics explicitly referenced `minwindef.h` macro expansion.
