# Oilpan Clang warning probes broke the GCC native build

## Symptom

The Ubuntu CI job failed five native tests while the rest of the TypeScript suite passed. Every failure converged on the shared Oilpan static-library build. GCC reported `missing binary operator before token "("` for two `__has_warning(...)` expressions in the vendored `src/base/macros.h`.

## Root cause

The header combined the capability check and the Clang-only builtin call in one preprocessor expression:

```cpp
#if defined(__clang__) && defined(__has_warning) && __has_warning("...")
```

GCC still has to parse the full preprocessor expression. Because it does not provide the function-like `__has_warning` builtin, parsing fails even though the preceding conditions are false. The fix is to nest the builtin invocation inside a separate guard that GCC can discard without parsing it.

## Investigation notes

- The GitHub Actions warnings about actions moving from Node.js 20 to Node.js 24 were unrelated; setup and the non-native tests completed successfully.
- The five failing tests were not independent compiler regressions. Their common failure was the single cached Oilpan build used by all native executables.
- A local macOS build alone could not reproduce the Linux diagnostic because `/usr/bin/g++` is AppleClang and supports `__has_warning`. The CI log's first C++ diagnostic was therefore more useful than the final five test summaries.
- Switching the Linux build to Clang would have hidden the header defect and introduced a separate compiler requirement. Patching the vendored source preserves the existing GCC path.

## Regression protection

`cli/nativePackaging.test.ts` now inspects the packaged Oilpan header and requires the Clang capability guard and builtin invocation to remain nested. The focused native smoke test also forces extraction of the changed archive and rebuilds the complete Oilpan library before compiling and running generated C++.
