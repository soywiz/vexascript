# Self-host regression streak and missing local completion gate

## Symptom and timeline

The compiler self-hosting job was red for four consecutive main-branch runs:

- `db460102` (`Expand VexaScript compiler and editor support`) first failed on
  2026-08-19 while clang compiled the JavaScript-hosted compiler;
- `fb15a710` added canonical filesystem identity and more generic inference
  work while the job was already red;
- `6bac6b94` and `e9e183cf` landed with the same self-host job still failing.

The ordinary test job and all three platform-native jobs remained green. The
same process problem had happened four days earlier: five consecutive
self-host jobs failed on 2026-08-16 before `e8293533` restored the bootstrap.
The failures therefore looked isolated even though the one red job was the only
job that compiled and executed the compiler through its complete native fixed
point.

## Failure chain

Several independent regressions accumulated behind the first visible failure.
Each repair exposed the next stage that CI had never reached:

1. New compiler source used TypeScript patterns that the native backend could
   not lower with stable C++ types. Combined `instanceof` branches lost native
   narrowing; spread and callback pipelines over maps and records became
   dynamic arrays; computed substitution callbacks and `Math.imul` produced
   unsupported C++.
2. `LocalVfs.realPath` imported `realpath` from `node:fs/promises`, but the
   native module mapping did not export that function. This later regression
   failed earlier than clang and masked all deeper failures.
3. Generic inference treated every distinct pair of named types as constructor
   callables. Comparing collection interfaces such as `Set<T>` and
   `ReadonlySet<string>` recursively constructed fresh callable types until the
   JavaScript host overflowed its stack.
4. The parser used `text.at(-1)`. The native emitter forwarded that call to
   `std::u16string::at(-1)` instead of JavaScript's negative-index semantics.
   Optimized C++ emitted a deterministic trap while parsing a type alias.
5. `Object.entries(...).map(([key, value]) => ...)` and spreading a `Set` into
   an array crossed dynamic collection boundaries during native execution.
   The native compiler reported only `VexaScript value is not a compatible
   array` at the entry module until LLDB identified the exact type-checker
   frames.
6. The first native generation eventually succeeded, but its emitted compiler
   still constructed generic `Map<Value, Value>` values where the next
   generation required `Map<string, AnalysisType>`. The final clang build
   caught these second-generation mismatches.
7. After both native generations compiled and ran, their C++ was still not
   byte-identical. Callback-heavy `find`/`map`/`filter` expressions inferred
   narrower return and collection types under the native compiler than under
   the JavaScript host. Explicit typed loops removed this last host-dependent
   emission path and restored the native fixed point.

The fixes keep collection types explicit: direct loops replace dynamic
`Object.entries` pipelines, set/map spreads, and inferred tuple-entry maps.
Callable-interface inference now uses interface call signatures rather than
class constructor signatures. Native filesystem support includes a real-path
primitive and module adapter. String `at` has a JavaScript-compatible native
runtime helper.

## Why existing validation missed it

`pnpm test` validates the TypeScript-hosted compiler. `pnpm test:native`
compiles representative language programs and the native CLI smoke, but it is
not the same as producing two compiler generations and comparing their output.
Neither command proves that every TypeScript idiom used inside the compiler has
a stable native representation across generations.

The repository already contained
`docs/journal/2026-08-16-cpp-self-host-dynamic-collection-boundaries.md`, which
said to validate self-host fixes through the full fixed point. That lesson was
passive documentation: `AGENTS.md` still required only `pnpm test` and the CLI
fixture before completion. There was no operational rule telling a later task
that compiler changes required local `pnpm self-host:ci`. CI detected the
regression, but direct follow-up work continued on main while the isolated job
was red, allowing later failures to hide behind the first one.

## Investigation notes and dead ends

- An identity-based recursion guard did not stop generic inference because each
  constructor conversion created fresh `FunctionType` objects. A temporary
  text-key guard stopped the loop, but it hid the architectural problem. Using
  only interface call signatures removed the recursive constructor path.
- The native trap initially appeared to occur after `typeTokenText`. Generated
  source for that helper was correct. LLDB disassembly showed that the optimizer
  placed the trap immediately after the inlined call because the following
  `std::u16string::at(-1)` was statically invalid.
- Fixing only the first `compatible array` error was insufficient. The same
  generic message represented different dynamic boundaries, so each stage had
  to be traced from `errorAtCurrentSource` to its native compiler frame.
- Stopping after the first native compiler generated C++ would still have
  missed typed-map errors in the compiler it produced. Only the second native
  build and fixed-point comparison close that gap.

## Regression protection

- `AGENTS.md` now requires `pnpm self-host:ci` in the final working-tree state
  for every compiler, CLI, native runtime/adapter, or bootstrap change. It also
  states explicitly that `pnpm test` is not a substitute.
- A focused module-graph test compiles a `node:fs/promises` `realpath` import
  through the native mapping.
- Generic inference has a collection-interface recursion regression test.
- The C++ emitter has a negative string-`at` regression test.
- The native ES2025 Math smoke extracts every ordinary numeric `Math` member
  from `es2025.d.ts`, compares that declaration set with its execution
  manifest, and compiles, links, and runs every member. This exposed twenty
  missing native members immediately, including `Math.imul`, and prevents new
  declared Math APIs from silently bypassing native execution coverage.
- `Math` is only the first declaration-locked slice. The existing ambient
  runtime-contract task now requires the same coverage rule across all exposed
  ES2025 families—strings, objects, arrays, dates, regular expressions,
  promises, collections, iterators, buffers, data views, and typed arrays.
  Each exposed member must execute natively or be rejected by a targeted
  diagnostic; a declaration that merely reaches broken generated C++ is a
  contract failure.

The durable rule is that self-hosting is a compiler acceptance test, not an
optional CI benchmark. A red self-host job must block additional compiler work
because its first error can mask failures in every later generation.
