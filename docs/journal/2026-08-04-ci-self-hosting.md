# CI compiler self-hosting bootstrap

## Context

The repository already had local JavaScript self-hosting and native CLI smoke
coverage, but CI did not run the two compiler generations as one explicit
bootstrap contract. It also did not expose comparable `tsc`, JavaScript, and
C++ timings separately from the ordinary test logs.

## Change

The dedicated `self-host` GitHub Actions job runs on its own Ubuntu runner. It
emits a runnable compiler with `tsc`, stages the required runtime/native assets,
and then performs two JavaScript bundle generations and three native C++
compile/link generations. JavaScript compares its bootstrap output with the
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

Native self-host executables are compiled with `g++ -O3`, and the timing table
records `Node.js / V8 JIT` or `g++ -O3` beside each host. Unoptimized `-O0`
generation is useful for debugging but is not a representative performance
comparison: historical measurements put the same workload near 60–71 seconds
at `-O0`, while optimized native compilers reached Node parity and later
outperformed it. The higher one-time `-O3` build cost remains outside the
generation benchmark and within the dedicated CI job timeout.

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
