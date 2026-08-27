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
8. The broader native CLI smoke then exposed a sparse-record contract bug.
   `importMappings` was typed as `Record<string, string>`, so native code
   converted a missing mapping to `string` before `??` could try the fallback.
   Modeling it as a partial record keeps missing entries as `undefined` until
   the branch proves that a mapped target exists.
9. The JavaScript and libc++ ECMAScript regex implementations do not accept
   exactly the same patterns. Lone braces in a TypeChecker cleanup pattern
   worked under V8 but failed in `std::regex`. Escaping the braces fixed the
   pattern, and the native regex wrapper now reports the rejected pattern in
   its diagnostic instead of only libc++'s opaque parser message.
10. `regex.exec(text)?.[1]?.trim()` exposed a general native optional-chain
    lowering bug: the computed access was guarded, but the following primitive
    method call was not. Primitive methods now use the same boxed optional-call
    contract as other native receivers, so a nullish intermediate remains
    `undefined` instead of reaching `trim(Value)`.

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
- The complete native suite also stops at the first assertion inside a long
  smoke. Once the sample bundle was repaired, the CLI regex incompatibility
  appeared; once that was repaired, Pixi exposed the optional-chain bug. A
  green earlier subcase is not evidence that later subcases ran.
- A final complete native rerun started while an independent tokenizer change
  still used object destructuring assignment. That run passed the native
  self-compilation fixed point but failed its last CLI-bundle link after the
  working tree had already moved to explicit temporary-field assignments.
  Re-running that exact native CLI/Pixi smoke against the current snapshot
  passed. Long native runs must therefore record their source snapshot; a
  failure from a superseded snapshot should be reproduced on the current tree
  before changing a shared emitter path.

## Regression protection

- `AGENTS.md` now requires `pnpm self-host:ci` in the final working-tree state
  for every compiler, CLI, native runtime/adapter, or bootstrap change. It also
  states explicitly that `pnpm test` is not a substitute.
- A focused module-graph test compiles a `node:fs/promises` `realpath` import
  through the native mapping.
- Generic inference has a collection-interface recursion regression test.
- The C++ emitter has a negative string-`at` regression test.
- The C++ emitter now has focused regressions for missing partial-record
  entries and primitive method calls after optional computed-member chains.
- Native regex construction reports the rejected pattern, making JavaScript
  versus libc++ compatibility failures actionable without a debugger.
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

## Follow-up: one canonical smoke and a declaration-wide contract

The original Math regression test repaired the immediate `Math.imul` failure,
but it still encoded the same architectural weakness at a smaller scale: Math
had a private inline native program while the repository already had a broad
native language smoke. Other standard-library families could continue to drift
without affecting that isolated test.

The coverage now lives in the existing `samples/native-language-smoke/`
fixture. `standard-library.vx` is imported by `main.vx`, runs silently near the
start of the executable, and contains the actual API calls. The previous
standalone Math native test and the duplicate ES2025 block at the end of the
sample were removed. A TypeScript-AST test extracts merged interface members
from `es2025.d.ts`; regex extraction was rejected because generic interfaces,
merged declarations, overload formatting, and namespace declarations made it
too easy to miss members.

The declaration bundle is the complete ECMAScript runtime surface, not only
the APIs introduced in ES2025. The durable contract therefore records every
named runtime family. Implemented members must have an execution label in the
canonical smoke. Deliberately unavailable families or members must be present
in `nativeStandardLibraryCoverage.ts`, and the emitter rejects their use with
the API name before invalid C++ can be generated. DOM and Worker APIs are not
in the bundled declaration file and are explicitly outside this pass.

The expanded smoke found three additional classes of drift immediately:

- global `encodeURI`, `decodeURI`, `escape`, and `unescape` existed in the
  runtime but were not routed through the emitter;
- `NaN` and `Infinity` were emitted as undeclared C++ identifiers;
- the newly pulled `sync { ... }`/`async { ... }` brace-lambda syntax produced
  `Task<T>` callbacks where an ordinary native callback expected `T`.

The last failure is especially important: parser, formatter, JavaScript
emitter, and LSP tests were all green, yet the syntax was unusable in a linked
native program. A single callback adapter now owns the native conversion, and
both modified brace-lambda forms execute in the canonical smoke.

## Follow-up investigation notes

- Moving `Object.groupBy` and `Atomics.waitAsync` checks from top level into the
  shared smoke function changed structural inference enough to generate direct
  C++ field access on `RecordObject*`. Adding more inferred structural access
  would have hidden the fixture move behind another special case. The checks
  instead validate the returned object through already-supported stable
  operations.
- Calling `Intl.DurationFormat.supportedLocalesOf` looked like a small runtime
  addition, but the declaration is a nested anonymous constructor property and
  currently resolves as `unknown`. It remains an explicit unsupported member;
  pretending to execute it in the smoke would only move the failure earlier in
  type checking without testing native behavior.
- An identity-only assignability recursion guard did not bound `Atomics`
  overload selection. Expanded typed-array interfaces repeatedly acquired new
  identities. Distinct built-in typed-array names are now rejected nominally,
  and deterministic work counters lock the overload check to bounded semantic
  work rather than a wall-clock threshold.
- The final fixed-point run exposed several failures that the focused native
  smoke could not reach because they were in the compiler implementation
  itself. A `String.concat` constant folder used a spread argument that the
  native emitter cannot lower, and the native runtime required a `start`
  argument for `String.slice()` even though the compiler calls `slice()` with
  the ECMAScript default. The folder now concatenates iteratively, and the
  runtime plus canonical smoke cover `slice()` with no arguments.
- The first unsupported-API lookup used plain record indexing. JavaScript
  inherited `constructor` from `Object.prototype`, so a local variable named
  `constructor` was misclassified as a standard-library owner. Filtering
  prototype keys fixed the bootstrap diagnostic, but iterating a record of
  interface-valued policies with `Object.entries` later exposed a native-host
  reboxing bug: the policy value arrived as `boolean`. The durable policy is
  now an array of explicitly typed entries, avoiding both prototype lookup and
  dynamic record access in the compiler fixed point.
- The literal-array `indexOf` optimization initially created heterogeneous
  `[comparison, index]` pairs before reversing them. JavaScript preserved the
  tuple types, while the native host homogenized the pair as `double[]` and
  generated an invalid string-to-number conversion. Generating the ordered
  checks with integer loops removes the intermediate representation entirely.
- Parenthesizing numeric literal member receivers fixed invalid JavaScript
  such as `12.toString()`, but the first version also changed extension calls
  from `extension(10)` to `extension((10))` and broke four output-shape tests.
  Parentheses now apply only to direct JavaScript member access. This was a
  focused-suite failure rather than a native failure, but it reinforces the
  need to run both gates after cross-emitter optimizations.
