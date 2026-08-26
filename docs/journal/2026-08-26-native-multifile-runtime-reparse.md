# Native multi-file runtime reparse cost

## Context

The expanded `samples/native-language-smoke` project took about 30 seconds to
produce an unoptimized native executable even though VexaScript-to-C++
generation completed in less than one second. The CLI reported the remaining
time as `native-compile-link`, which did not distinguish C++ compilation from
the final linker invocation.

## Investigation

A clean `-O0` modular build generated 22 translation units. Every generated
`.cpp` included `program.hpp`, and `program.hpp` included the complete
10,456-line `native/runtime.cpp` plus 2,825 lines of generated declarations.
Consequently, even a generated module containing only 15 lines took about 1.98
seconds to compile. Sequentially compiling all 22 units took about 52.12
seconds; the CLI's two-worker pool reduced wall time to 28.01 seconds while
consuming 51.25 seconds of user CPU.

Re-linking the already-built 22 object files took only 0.10 seconds. The linker
was therefore not the bottleneck despite the combined timing label. Dependency
preparation was also ruled out because the cached Oilpan and mimalloc libraries
were reused.

## Resolution

The native CLI now emits one C++ translation unit by default. The modular
layout remains available explicitly with `--module-files`, while
`--single-file` remains a compatible explicit spelling of the default. Native
module smoke tests request `--module-files` so the alternative layout continues
to receive executable coverage.

The runtime was then split into a generated-code header (`runtime.hpp`) and a
separately compiled `runtime.cpp` archive. Native dependency preparation stores
the archive and, for Clang, a compatible precompiled header under
`~/.vexascript/native`. The source-hosted cache key hashes the runtime, BigInt,
and UTF sources together with the compiler configuration. The archive is
whole-archive linked so it participates in every native executable instead of
remaining an unused optional archive member.

For the complete language smoke test, clean `-O0` native compile-and-link time
fell from 28.01 seconds to 6.60 seconds. A separately measured single-file
compile took 6.59 seconds and its pure link took 0.10 seconds. End-to-end CLI
wall time, including rebuilding the TypeScript CLI and generating C++, fell
from 30.22 seconds to 8.78 seconds. The produced executable matched
`expected.native.txt`.

With the reusable runtime cache warm, the same single-file native compile/link
took 5.87 seconds. An uncached project using the explicit modular layout took
19.16 seconds with the cached runtime header, down from 28.01 seconds. Creating
the runtime archive and precompiled header makes the first build for a new cache
key slower; subsequent projects amortize that one-time work.

## Dead ends and lessons

Increasing the compile worker count could shorten the modular wall time on
machines with spare cores, but it would not remove the repeated parse and
template-instantiation work and would increase peak memory pressure. The
durable default is to avoid duplicating that work. If modular output becomes
important for incremental native builds, object files should gain per-unit
freshness caching.

The runtime header necessarily retains template definitions and class layouts
used by generated types. A static library alone therefore cannot eliminate all
per-program C++ code generation. The precompiled header removes repeated
parsing, while the archive caches the stable runtime object code; further gains
require moving additional non-template method bodies out of the header without
creating a parallel runtime implementation.

Future native profiling should report C++ compilation and pure linking as
separate phases. A combined `native-compile-link` duration can incorrectly
focus investigation on the linker.

The first native fixed-point attempt exposed a self-host-only inference edge:
array literals that mixed `...frontendArgs` with additional strings lowered to
`Array<Value>` even though `runNativeCompiler` requires `string[]`. Building the
argument arrays incrementally with `slice()` and `push()` preserved the concrete
element type under both the JavaScript and C++ hosts. The failed generated C++
diagnostic was useful evidence; weakening `runNativeCompiler` to accept dynamic
values would have hidden the compiler issue and spread conversion work into the
native adapter.

## Execution metadata

- Provider: OpenAI
- Model: Unavailable (not exposed by runtime)
