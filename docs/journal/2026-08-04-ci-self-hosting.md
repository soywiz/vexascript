# CI compiler self-hosting bootstrap

## Context

The repository already had local JavaScript self-hosting and native CLI smoke
coverage, but CI did not run the two compiler generations as one explicit
bootstrap contract. It also did not expose comparable `tsc`, JavaScript, and
C++ timings separately from the ordinary test logs.

## Change

The dedicated `self-host` GitHub Actions job runs on its own Ubuntu runner. It
emits a runnable compiler with `tsc`, stages the required runtime/native assets,
and then performs two JavaScript bundle generations and two native C++
compile/link steps around three C++ generations. JavaScript compares its bootstrap output with the
next generation. Native C++ compares the outputs of two consecutive native
compilers, because the TypeScript-hosted bootstrap has slightly different type
precision while the native generations reach a byte-stable fixed point. Each
comparison reports a SHA-256 digest.

The timing table is written to `GITHUB_STEP_SUMMARY`, so it appears in the
workflow-run summary instead of being mixed into the normal command output.
C++ generation is the only benchmark reported in the comparison table, and all
durations are rendered in seconds. Each generation timer wraps only `vexa cpp
build`; native dependency preparation and the later g++ compile/link calls run
outside those timers. Native linking remains part of the validation sequence
needed to execute the next compiler generation, but its duration is deliberately
not presented as compiler-generation performance. The table keeps the second
native generation as a fixed-point check. The driver still publishes the table
when a stage fails; the job exits non-zero after all independent stages have had
a chance to report their state.

Native self-host executables are compiled with `-O3`, and the timing table
records `Node.js / V8 JIT` or the effective native compiler beside each host.
GCC remains the primary Linux compiler; an individual translation unit retries
with Clang when GCC reports an internal compiler error, and the summary records
that mixed fallback instead of incorrectly claiming a pure GCC build. Unoptimized `-O0`
generation is useful for debugging but is not a representative performance
comparison: historical measurements put the same workload near 60–71 seconds
at `-O0`, while optimized native compilers reached Node parity and later
outperformed it. The higher one-time `-O3` build cost remains outside the
generation benchmark and within the dedicated CI job timeout.

## Monolithic C++ memory regression

The first optimized CI attempt emitted the compiler as one very large
`main.cpp`. On the hosted x86-64 runner, the first native compiler was then
terminated while generating the next C++ generation. The process wrapper kept
stdout and stderr but discarded the child `close` signal, so the summary only
reported an unknown exit code. The wrapper now streams both output channels as
they arrive and preserves signals such as `SIGKILL`, which distinguishes an
OOM-style termination from a normal compiler diagnostic.

A constrained Ubuntu 24.04 container reproduced a second toolchain problem:
GCC 13 hit an internal compiler error on the monolithic compiler at both `-O1`
and `-O3`, then the existing Clang fallback completed. `-O1` reduced the full
native stage from roughly 794 seconds to 618 seconds and lowered peak memory,
but did not remove the GCC failure, so reducing optimization was not a durable
fix. An ARM64 `-O3` fallback run completed under a 7 GB limit but reached about
4.4 GB resident memory, confirming that moving to macOS could hide the symptom
without fixing the oversized translation unit.

The native backend now retains whole-program semantic analysis but emits
`program.hpp`, `main.cpp`, and one deterministic `module-XXXX.cpp` per source
module. Non-template top-level functions and class methods move out of the
shared header into their owning module; template definitions remain visible in
the header. Native builds compile those files to objects with bounded
parallelism and link the objects in a separate command. The compiler self-host
comparison hashes the complete sorted C++/header file set, not only `main.cpp`,
and still performs the two links required to execute each native host that
produces the next generation. The final fixed-point output is compared but not
linked because no later generation executes it.

The bootstrap output and the native fixed-point output are deliberately two
separate equality contracts. The TypeScript and JavaScript hosts must emit the
same bootstrap C++, while two consecutive native hosts must emit the same
native C++. Comparing the bootstrap C++ directly with the native C++ was an
overly strict regression introduced while splitting timings: the native host
has different type precision, so those representations can differ even when
the native compiler has reached a stable fixed point.

## Recovery after the ambient-runtime experiment

The declaration-driven ambient-runtime experiment made the first native
compiler link but prevented it from compiling the next generation. Restoring
the last stable C++ emitter/runtime removed that architectural regression while
retaining the newer syntax and analysis work. The remaining self-host failures
were source-shape ambiguities: heterogeneous tuple arrays used to construct
maps, narrow literal sets widened to `Value`, and nullable internal strings or
binding names that changed representation in the native compiler.

The durable fixes use explicit typed map insertion, homogeneous `Set<string>`
storage, and simple control flow or empty-string sentinels at emitter-internal
boundaries. LLDB breakpoints on the failing conversion branches identified the
exact native caller much faster than changing runtime coercion rules. The
stable runtime remains strict, and the second and third native outputs are now
byte-identical.
