# Native runtime performance needs equivalent cross-runtime workloads

## Symptom

The native runtime benchmark only recorded native values. That made it impossible
to tell which generated-code operations were genuinely faster than Node.js and
which runtime paths were hidden by the faster native process startup. The much
larger self-hosted compiler workload also remained slower than Node.js even when
small native workloads were already faster.

## Investigation

The benchmark was changed to compile one VexaScript workload to both C++ and
JavaScript and execute each artifact repeatedly. Native arrays, timers, startup,
and the aggregate workload were faster, but the bigint loop was roughly 28 times
slower than Node.js in the first direct measurement. The loop divided an
increasing bigint by `3n` on every iteration.

The arbitrary-precision implementation sent every division through its general
bit-at-a-time long-division fallback. That algorithm remains useful as a compact,
dependency-free implementation for multi-limb divisors, but it performs much
more work than necessary when the divisor fits in one 32-bit magnitude limb.

The new benchmark initially failed semantic analysis after switching its timing
source from `Date.now()` to `performance.now()`. Native C++ lowering already
supported the call, and browsers and Node.js provide it at runtime, but the
shared non-DOM declarations did not expose the global. The prior emitter test
had hidden the mismatch with `typeCheck: false`.

## Resolution

`BigInt` division now detects a single-limb divisor and performs one linear pass
over the dividend using the existing small-division primitive. Signed quotient
and remainder behavior is preserved, and multi-limb division still uses the
general fallback. An isolated compiled C++ test covers positive and negative
operands, a divisor near the 32-bit limit, and the multi-limb path.

The shared ECMAScript declarations now include the portable high-resolution
`Performance.now()` surface. Its C++ emitter test runs with semantic checking
enabled, preventing the runtime implementation and declaration surface from
drifting again.

On the measured darwin/arm64 machine, bigint time fell from 1.33 ms to 0.08 ms.
The identical complete workload ran in a 7.82 ms median natively versus 41.25 ms
under Node.js, a 5.28x end-to-end speedup. Individual timings remain
informational rather than test thresholds because they vary by machine and load.

The self-host profile exposed a different allocation pattern. Array transforms
copied elements and grew result storage repeatedly, template literals emitted
deep chains of dynamic `add` calls, and every repeated regular-expression literal
constructed a fresh UTF-16 regex. The runtime now reserves array results and moves
temporary elements where ownership is clear, joins mapped text with one exact-size
allocation, and caches compiled regular expressions. The emitter flattens known
string concatenation trees into one `concatText` call while still preserving
resolved operator overloads. In the generated self-host source this reduced
dynamic `add` calls from 1,259 to 10.

Those changes reduced the reported 3.66-second self-host wall time to a 2.37-second
warm median. The equivalent Node CLI measured 2.15 seconds, so the real compiler
is much closer but remains about 10% faster under Node; the remaining gap is
concentrated in C++ emission. Increasing Oilpan's initial heap ceiling from 2 GB
to 4 GB was tested and rejected because it worsened the median to 2.57 seconds.
