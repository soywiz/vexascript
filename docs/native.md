# Native C++ backend

VexaScript can emit a C++ translation unit from a single source file:

```sh
vexa build main.vx --emit cpp
```

The default output is `main.cpp`. To compile directly to a native executable,
use:

```sh
vexa native main.vx
./main
```

The intermediate C++ file is written to `main.vx.build/main.cpp`. Use
`--build-dir <dir>` to select a different intermediate directory and
`-o <file>` to select the executable path. `vexa build main.vx --native` remains
an alias for this direct native workflow.

The first native build extracts `native/oilpan-standalone-main.zip` and builds
`liboilpan_gc.a` under the operating system's temporary directory, with CMake
configured to use `g++`. Later builds reuse that temporary cache. The final
generated translation unit is compiled and linked with `g++ -std=c++20`.

## Requirements

- `g++` with C++20 support
- CMake 3.20 or later
- `unzip`
- Make or another CMake-supported build tool

The vendored Oilpan source is prepared for macOS and Linux on arm64/aarch64 and
x86_64.

## Initial supported surface

The native backend intentionally rejects unsupported AST constructs instead of
silently producing incorrect C++. Its initial surface includes:

- local variables and primitive number, boolean, string, null, and undefined values;
- concrete primary-constructor classes whose `val`/`var` properties use primitive
  types, including construction and property reads;
- range-based `for` loops lowered to native C++ loops;
- `if`, `while`, `do while`, return, break, and continue statements;
- arithmetic, comparison, assignment, unary, update, and conditional expressions;
- `console.log`, `console.info`, `console.warn`, and `console.error`;
- common `Math` constants and functions;
- basic `String`, `Number`, `Boolean`, `parseInt`, `parseFloat`,
  `isNaN`, `isFinite`, `toString`, `toFixed`, casing, and trimming APIs.

Numeric VexaScript types keep their intended native representation: `int` maps
to `std::int32_t`, `long` maps to `std::int64_t`, and `number` maps to C++
`double`. Range-loop iterators use the analyzed element type rather than a
single hard-coded numeric type.

The runtime lives entirely in `native/runtime.cpp`. It initializes an actual
cppgc heap, represents runtime strings as `cppgc::GarbageCollected` objects,
keeps live strings rooted with `cppgc::Persistent`, and allocates generated
class instances through the same Oilpan heap.

Native emission currently supports single-file builds only and cannot be
combined with `--bundle` or project-directory builds.
