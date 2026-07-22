# Native C++ Benchmarks

Run `pnpm benchmark:native` from the repository root. The command builds fresh
empty, workload, and GC-stress executables in a temporary directory, executes
multiple startup/workload samples, compiles the identical workload to JavaScript
for Node.js, and prints a Markdown table. Results are informational because
compiler, runtime version, CPU, operating system, and thermal state strongly
affect measurements.

## Native versus Node: 2026-07-22

Platform: darwin/arm64, AppleClang through `/usr/bin/g++`, release Oilpan build,
Node.js executing the JavaScript emitted from the same source.

| Metric | Native | Node | Native speedup |
| --- | ---: | ---: | ---: |
| Startup median | 5.47 ms | 35.06 ms | 6.41x |
| Workload median | 7.82 ms | 41.25 ms | 5.28x |
| Array workload | 0.88 ms | 2.20 ms | 2.50x |
| Bigint workload | 0.08 ms | 0.04 ms | 0.50x |
| Event-loop workload | 0.03 ms | 1.84 ms | 61.33x |

The native workload binary was 821,336 bytes and generated, compiled, and linked
in 2,875.72 ms. The GC-stress variant completed in 373.39 ms. The bigint workload
previously took 1.33 ms natively because division by the constant `3n` used the
general bit-at-a-time algorithm. A single-limb division path reduced it to
0.08 ms while retaining the general fallback for larger divisors. The aggregate
native workload is faster both because startup is lower and because the measured
array and event-loop operations execute faster than their Node.js equivalents.

The larger self-hosted `cpp cli/cli.ts --target optimized` workload improved from
the reported 3.66-second wall time to a 2.37-second warm median. Its matching Node
CLI measured 2.15 seconds on the same machine, leaving the native self-host about
10% slower. Phase timings locate that remaining difference primarily in C++
emission rather than parsing. A 4 GB initial Oilpan heap increased the native
median to 2.57 seconds, so the existing adaptive 2 GB ceiling remains preferable.

## Baseline: 2026-07-17

Platform: darwin/arm64, AppleClang through `/usr/bin/g++`, release Oilpan build.

| Metric | Value | Unit |
| --- | ---: | --- |
| Compile | 2238.29 | ms |
| Binary size | 455032.00 | bytes |
| Startup median | 6.23 | ms |
| Workload median | 14.23 | ms |
| GC-stress workload | 441.23 | ms |
| Array workload | 5.03 | ms |
| Bigint workload | 1.19 | ms |
| Event-loop workload | 0.04 | ms |

The workload creates and scans 100,000 array elements, performs 250 chained
arbitrary-precision bigint multiply/add/divide operations, and settles 250
zero-delay timers on the native event loop. The GC-stress measurement runs the
same workload with forced Oilpan safe-point collections.
