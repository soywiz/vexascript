# Native C++ Benchmarks

Run `pnpm benchmark:native` from the repository root. The command builds fresh
empty, workload, and GC-stress executables in a temporary directory, executes
multiple startup/workload samples, and prints a Markdown table. Results are
informational because compiler, CPU, operating system, and thermal state strongly
affect native measurements.

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
