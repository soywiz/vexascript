# Native C++ backend

VexaScript exposes all native workflows below the `cpp` command:

```sh
vexa cpp main.vx
vexa cpp build main.vx
```

Both forms compile to a C++ translation unit. The default output is `main.cpp`;
`-o <file>` selects another C++ output path. To compile and link a native
executable, use:

```sh
vexa cpp link main.vx
./main
```

The intermediate C++ file is written to `main.vx.build/main.cpp`. Use
`--build-dir <dir>` to select a different intermediate directory and
`-o <file>` to select the executable path. `cpp run` performs the same build,
then executes the resulting program. TypeScript entrypoints are accepted too:
`vexa cpp link main.ts`.

Select the native C++ optimization level when linking with one of `-O0`, `-O1`,
`-O2`, `-O3`, `-Os`, `-Oz`, or `-Og` (`-O2` is the default):

```sh
vexa cpp link main.vx -O0
vexa cpp link main.vx -O1
vexa cpp link main.vx -O2
vexa cpp link main.vx -O3
vexa cpp link main.vx -Os
vexa cpp link main.vx -Oz
vexa cpp link main.vx -Og
```

The selected level is part of the native executable cache key, so changing it
relinks the executable even when the generated C++ is unchanged.

All four forms use the same complete module graph. `cpp link` and `cpp run`
cache the generated C++ and linked executable; unchanged sources reuse both
artifacts. Measurements use the monotonic high-resolution `performance.now()`
clock on Node.js and browsers.

All native C++ commands emit one translation unit by default. This avoids
reparsing the native runtime and the generated shared declarations once for
every source module. Pass `--module-files` to emit `program.hpp`, `main.cpp`,
and one deterministic `module-XXXX.cpp` translation unit per source module.
`--single-file` remains available as an explicit spelling of the default.

JavaScript file builds print source/project/declaration loading, type-check,
parse, analysis, emission, write, and total timings. For `.ts` inputs the
external `tsc --noEmit` check runs concurrently with VexaScript compilation, so
the individual durations intentionally do not add up to the total.

The first native build extracts `native/oilpan-20260622.zip` and
`native/mimalloc-3.4.3.zip` under `~/.vexascript/native`. CMake builds and
reuses platform- and architecture-named static libraries such as
`liboilpan-20260622-darwin-aarch64.a` and
`libmimalloc-3.4.3-darwin-aarch64.a`; later builds reuse both caches. The final
generated translation unit is compiled and linked with the selected C++
compiler (`clang++` when available, otherwise `g++`) using C++20 plus the
selected optimization level. The
trimmed mimalloc ZIP contains its
source/include tree plus only the three small CMake modules needed to configure
the object build. The generated translation unit uses the selected optimization
level (default `-O2`). Sanitizer builds omit mimalloc so ASan can
observe allocations through the system allocator.

The VexaScript runtime is cached in the same directory as a
`libvexa-runtime-*.a` static library. Every focused runtime header has a matching
translation unit; concrete functions and methods are compiled independently,
while template and `constexpr` implementations remain visible in headers as
required by C++. Runtime object files are built in a temporary directory and
removed as soon as the archive is created. Clang builds also retain a
content-addressed precompiled `runtime.hpp`, so generated translation units do
not repeatedly parse the complete runtime interface. The runtime cache does not
copy headers, sources, dependency ZIP files, or object files; its only
runtime-specific artifacts are the static archive and, for Clang, its compatible
PCH. The cache key hashes
the raw bytes of every runtime category header and source, plus the compiler,
platform, architecture, optimization level, instrumentation mode, and native
flags. Changing any of them creates a new archive instead of reusing an
incompatible one. GitHub Actions deliberately persists only the more stable
Oilpan and mimalloc caches between workflow runs; content-addressed
`vexa-runtime-*` archives and PCH files remain local to one runner execution so routine
runtime edits do not accumulate remote cache variants.

ECMAScript `Map`, `Set`, `WeakMap`, and `WeakSet` type arguments remain part of
VexaScript's static type system, but they do not produce distinct C++ runtime
classes. The generated program uses the concrete `MapObject`, `SetObject`,
`WeakMapObject`, and `WeakSetObject` classes, whose contents use the common
`Value` representation. This matches JavaScript collection identity and permits
values to cross `any` boundaries without selecting a different C++ template
instantiation. Language arrays still expose a typed C++ view in this phase;
compatible covariant views share dynamic backing storage, while native-only
arrays whose elements cannot be represented as ECMAScript values, such as
internal task storage, retain typed slots. Removing the remaining
`ArrayObject<T>` adapter and validating the final `any[]` contract is a separate
follow-up phase.

The native CLI also runs the JavaScript bundler in-process. The bundler is
implemented in TypeScript, included in the native CLI module graph, and compiled
to C++ with the rest of the CLI; it does not invoke Node.js or another `vexa`
executable. Native adapters provide the asynchronous VFS-backed local-module
graph, package declaration resolution, and embedded DOM declarations needed by
the shared bundling pipeline.

Published `.js`, `.mjs`, and `.cjs` package modules use the existing
VexaScript tokenizer to locate and rewrite static `import`/`export` declarations
and literal dynamic imports. Their JavaScript bodies are preserved rather than
parsed and re-emitted. TypeScript, TSX, JSX, and VexaScript sources continue to
use the full parser and emitter because they require syntax lowering and type
information. `tests/native/nativeSmoke.native.ts` compiles the CLI with `-O0`, uses that
native executable to bundle both a small Node fixture and the Pixi browser
sample, and syntax-checks the Pixi result.

Explicit text-module imports use a `?text` suffix:

```typescript
import declarations from "./runtime.d.ts?text"
```

The bundler reads the referenced file asynchronously and replaces the import
with a string constant regardless of the file extension. Native compilation
performs the same replacement in the module AST before merged analysis, so the
text becomes a native string literal and the source file remains a watched
build input. The native CLI uses this path for its canonical ECMAScript,
VexaScript, and DOM declaration files instead of compiling generated TypeScript
wrappers for those sources. The same import form is handled by a small
asynchronous ESM loader during direct Node/tsx execution and by a shared
esbuild plugin for the CLI, website, and VS Code bundles, so
`embeddedRuntimeSources.ts` is only a stable two-import facade.

## Requirements

- `g++` with C++20 support
- CMake 3.20 or later
- Make or another CMake-supported build tool

The vendored Oilpan source is prepared for macOS and Linux on arm64/aarch64 and
x86_64, and for 64-bit Windows with MinGW-w64. On Windows, `g++` and
`mingw32-make` must be available on `PATH`.

The end-to-end regression lives in `samples/native-language-smoke/`. It is a
multi-file program covering functions, classes, interfaces, operators, managed
arrays and records, control flow, exceptions, generators, promises, timers, and
local imports. Focused compiler semantics are grouped under
`language-features/`, separately from the ECMAScript APIs under
`standard-library/`. `tests/native/nativeSmoke.native.ts` compiles the fixture
through the public `cpp link` command, runs the resulting process, and compares
its complete stdout with `expected.txt`. The ordinary sample harness uses the
same expectation for JavaScript, so observable output cannot drift between
backends.

## Initial supported surface

The native backend intentionally rejects unsupported AST constructs instead of
silently producing incorrect C++. Its initial surface includes:

- local variables and primitive number, boolean, string, null, and undefined values;
- typed top-level functions, including forward calls, named-argument reordering,
  literal default arguments, recursion, inferred `void` returns, class-instance
  parameters, calls from other functions or methods, and `async`/`sync` functions
  represented as native `Task<T>` values;
- concrete classes whose primary-constructor properties and initialized instance
  fields use primitive types or other generated classes, including construction,
  explicit `new` construction, property access, synchronous typed instance and
  static methods, static factory methods that return class instances, and
  `async`/`sync` methods, plus synchronous class operator overloads;
- required and optional method-and-property interfaces, multiple interface
  inheritance, concrete and structural conformance, virtual method/property
  dispatch through interface-typed values, and homogeneous arrays containing
  different implementations of one interface;
- numeric `enum` and `const enum` declarations with automatic values, explicit
  integer constant expressions, enum-typed parameters and returns, member access,
  bitwise operations, homogeneous arrays, and switch cases;
- non-generic type aliases of supported native types, including nested aliases
  and declared homogeneous array parameter types;
- homogeneous arrays with a supported native element type and mixed primitive
  arrays represented by managed dynamic values, including literals, indexed
  reads and writes, `length`, `push`, `includes`, `indexOf`, `lastIndexOf`, `at`,
  `join`, `reverse`, `splice`, `fill`, `copyWithin`, `flat`, `flatMap`, `forEach`,
  `some`, `every`, `find`, `findIndex`, comparator/default `sort`, and synchronous
  `for-of` loops with identifier or destructuring bindings;
- range-based `for` loops lowered to native C++ loops and reusable inclusive or
  exclusive range expressions backed by typed native vectors;
- `if`, `while`, `do while`, integral and value-based `switch`, return, break,
  continue, `throw`, `try`/`catch`/`finally`, and `defer` statements;
- arithmetic and managed string concatenation, comparison including `<=>`, array
  and range membership, assignment, truthy logical/unary conditions, update,
  conditional, comma, and lazy nullish-coalescing expressions;
- arbitrary-precision `bigint` literals and construction, arithmetic,
  exponentiation, comparisons, bitwise operations, shifts, conversion, managed
  arrays, and dynamic-value storage without an external bigint library;
- synchronous typed arrow functions and anonymous function expressions, including
  generated-class parameters and captures;
- `console.log`, `console.info`, `console.warn`, and `console.error`;
- a single-threaded event loop with microtasks, `setTimeout`, `setInterval`,
  `clearTimeout`, and `clearInterval`;
- `Promise { resolve, reject -> ... }` executor construction backed by the same
  native task state, including timer-safe resolver callbacks and first-settlement
  semantics;
- lazy generator functions and instance methods backed by C++20 coroutines,
  including `yield`, `yield*`, final return values, `.next()`, `.next(value)`,
  `.return()`, generator `for-of` iteration, and async/sync generators that use
  the native task runtime;
- common `Math` constants and functions;
- basic `String`, `Number`, `Boolean`, `parseInt`, `parseFloat`,
  `isNaN`, `isFinite`, `toString`, `toFixed`, casing, and trimming APIs.

Numeric VexaScript types keep their intended native representation: `int` maps
to `std::int32_t`, `long` maps to `std::int64_t`, and `number` maps to C++
`double`. `bigint` maps to the runtime's arbitrary-precision `vexa::BigInt`,
which stores a sign and base-2^32 magnitude limbs. Its multiplication is
grade-school. Division by a single magnitude limb uses a linear pass over the
dividend; larger divisors retain the dependency-free bit-at-a-time fallback.
Range-loop iterators use the analyzed element type rather than a single
hard-coded numeric type. Numeric remainder uses the shared native
`remainder` helper, preserving integral `%` behavior while mapping `number`
operands to `std::fmod` instead of emitting invalid C++ floating-point `%`.

The public runtime umbrella lives in `native/runtime/runtime.hpp`. Focused category
headers beside it contain arrays, collections, dates, strings, regular expressions,
internationalization, binary data, promises, JSON, and the remaining runtime areas.
Every `.cpp` beside those headers is compiled once into the cached runtime
library. `bigint.hpp` and `utf.hpp` expose their declarations using the same
header/implementation split. The runtime initializes an actual
cppgc heap, represents dynamic `vexa::Value` strings as
`cppgc::GarbageCollected` objects, keeps live dynamic strings rooted with
`cppgc::Persistent`, and allocates generated class instances through the same
Oilpan heap. Language arrays are `cppgc::GarbageCollected` backing objects with
reference semantics: assignment, parameter passing, and storage in multiple
objects copy only the array handle, so mutation remains visible through every
reference. Generated object fields store those handles as `cppgc::Member` edges
and visit them from `Trace`; when the last reachable owner disappears, Oilpan can
collect the array even when it participates in a cycle. Primitive and owned
`std::string` elements need no interior tracing, generated-object elements use
`cppgc::Member`, and mixed `vexa::Value` elements use the same traced
`StoredValue` representation as managed records. Array-producing operations such
as literals, `slice`, `concat`, `map`, `filter`, `split`, `Object.keys`, and
`Promise.all` allocate a new managed backing object, while mutating operations
retain the original identity.

Oilpan uses its normal adaptive heap-growth policy by default. Long-running,
allocation-heavy native tools can set `VEXA_NATIVE_INITIAL_HEAP_MB` to delay the
first automatic collection until the heap reaches that many megabytes. This is
a retention-versus-throughput control rather than an eager reservation: for
example, the self-hosted compiler runs measurably faster with a larger initial
heap, while ordinary applications should normally keep the default.
Generated objects stored in another generated object's primary-constructor or
ordinary instance fields use `cppgc::Member<T>` and are visited by the owner's
generated `Trace` method. Field initializers that allocate managed strings or
objects use the hidden runtime passed to the generated constructor.
Generated interfaces inherit `cppgc::GarbageCollectedMixin`, so interface-typed
fields and persistent callback captures retain the concrete Oilpan object and
dispatch tracing through the interface hierarchy.

Generated functions and methods receive the active runtime through a hidden C++
parameter. VexaScript call sites remain unchanged. This keeps heap ownership and
destruction order explicit without introducing a process-global application
singleton. Function and method parameters require supported type annotations;
value-returning callables also require an explicit return type. Literal defaults
are lowered into generated call sites rather than C++ declaration defaults.
Callable values stored in `vexa::Value` are managed `FunctionObject` instances.
Their actually referenced managed captures are copied into traceable
`StoredValue` edges owned by the function object, while the C++ lambda keeps
non-rooting handles. Consequently record/array/object/closure cycles remain alive
while reachable and become collectible together; unrelated lexical values are
not retained merely because they were in scope when the closure was created.
Synchronous instance getters written with either `get name()` or the expression
shorthand `name: Type => expression` are emitted as ordinary native methods and
property reads call them automatically. Synchronous `set name(value)` accessors
use an overloaded native method and preserve direct, compound, prefix, and postfix
assignment results. Generic functions, classes, methods, interfaces, and
extension methods emit as C++ templates using analyzer-resolved types.

Both JavaScript and C++ emission consume the analyzer's resolved implicit-receiver
identifier sets. The analyzer decides whether an unqualified identifier means a
local, an instance member, or a static member; each backend only chooses its target
spelling (`this.member`, `this->member`, or `Class::member`). The C++ emitter does
not repeat field-name or local-shadowing inference.

Native interfaces are emitted before their implementing classes as abstract C++
bases. Their method signatures use the same hidden-runtime and argument-conversion
helpers as ordinary class methods. Member-call lookup starts from the analyzer's
receiver type and walks an interface's declared base, so virtual dispatch adds no
parallel assignability or overload-selection logic to the emitter. Required
properties implemented by primary-constructor fields, regular class fields, or
computed class getters receive virtual getter bridges; mutable field-backed
properties also receive setter bridges. Getter/setter accessor pairs implement
mutable interface properties through the same bridges. Direct, compound, prefix,
and postfix writes preserve single receiver evaluation. Generic, optional-member,
and multiple-inheritance interfaces are supported. Missing optional properties
read as `undefined`; invoking a missing optional method raises a native runtime
error, as calling an undefined JavaScript member would.

Numeric enums emit a type namespace containing `std::int32_t` constants. Automatic
members refer to the previous constant, while explicit arithmetic, shift, and
bitwise initializers remain C++ constant expressions; the emitter changes syntax
but does not independently calculate enum values. String, ambient, and non-constant
native enums remain unsupported. Non-generic aliases recursively use the ordinary
declared-type mapper, and array aliases use the same array-suffix parser as semantic
analysis.

Native `async` and `sync` calls enqueue their callable body as a microtask on the
same `Runtime` that owns timers. `await` waits for a `Task<T>` while pumping that
event loop, `sync` uses the analyzer's existing auto-await set, and `go` retains the
task without waiting. Both `Promise<T>` annotations and VexaScript's shorthand
non-Promise async return annotations map to `Task<T>`. Returning another task from
an async callable is flattened.

Source-level `Promise` construction does not create a parallel runtime object or
scheduler. The C++ emitter lowers its executor to `Task<T>::create`; the executor
runs immediately, while its `resolve` and `reject` handles retain shared settlement
state and may safely be passed to `setTimeout`. Timers accept heterogeneous
callback arguments and async anonymous callbacks. An unparameterized `Promise` uses
dynamic `vexa::Value`, so calling `resolve()` settles it with `undefined` and
`resolve(value)` stores the supplied value. Repeated resolve/reject attempts are
ignored after the first settlement, and awaiting a rejection rethrows it.

Native generators are lazy C++20 coroutines. A plain generator returns
`Generator<T>`; a generator with VexaScript's async-capable modifier returns
`AsyncGenerator<T>`. Calling `.next()` produces the usual `{ done, value }`
result, and an async generator's result participates in the existing `await`
lowering. `.next(value)` sends a value back into the suspended `yield` expression;
as in JavaScript, an argument supplied to the first `next` call is ignored.
`.return()` closes the coroutine, destroys its frame, and returns a completed
iterator result. `yield*` delegates to native arrays or another generator and
converts delegated dynamic strings through the active runtime. Generator parameters,
method receivers, local generated objects, yielded objects, and returned objects
are kept in Oilpan `Persistent` roots while their coroutine frame is suspended.
The analyzer remains the source of truth for each callable's resolved
`Generator<T>` or `AsyncGenerator<T>` element type; the C++ emitter only maps
that analyzed type to its native representation.

The generated entrypoint drains the event loop before destroying the runtime and
Oilpan heap. A live interval therefore keeps the process alive until it is cleared,
matching the usual timer lifecycle. Timer callbacks support async or synchronous
functions and arrows with source callback arguments. Top-level arrows capture entrypoint locals by
reference; arrows created inside a callable capture ordinary values by value and
root captured generated class objects with `cppgc::Persistent`.

Integral and boolean switches emit direct C++ `switch` statements. Other
comparable discriminants, including managed strings and dynamic values, are
evaluated once and mapped to a native case index before entering a C++ switch;
this preserves source case-expression order, fallthrough, and defaults without
duplicating the discriminant expression.

Source throws are normalized through `throwValue` into native exceptions. Catch
bindings receive the exception message as a managed VexaScript string. `finally`
uses explicit pending-completion propagation, so it runs for normal completion,
return, throw, break, and continue. A completion produced by the `finally` block
overrides the pending completion, matching the source-language ordering even for
nested cleanup. Callable and loop boundaries convert internal completion signals
back into native control flow; GC pointer return values remain rooted while cleanup
runs. The shared lowering means `defer` uses exactly the same path. Labeled break
and continue use labeled completion signals, so they cross nested loops and
`finally` cleanup before being consumed by the selected loop.

Reusable `...` and `..<` expressions materialize a typed native vector, so they
can be stored and traversed more than once; direct range `for` loops keep their
allocation-free lowering. Comma expressions preserve left-to-right evaluation.
Dynamic `??` uses a callback-based runtime helper so the right operand is only
evaluated for `null` or `undefined`; statically non-null native values omit the
fallback entirely.

Managed string and dynamic `+`/`+=` expressions share one runtime addition path,
which keeps resulting strings on the Oilpan heap. Conditions and logical operators
use the runtime's VexaScript truthiness conversion, including `NaN`, empty managed
strings, arrays, and generated-object pointers. Primitive `<=>` and relational
string comparisons use one comparison helper, while `in` over native arrays and
ranges shares the same `includes` implementation as collection method calls.
Template-string interpolation uses that same parser-level concatenation lowering,
including nested interface and computed-property reads; the C++ backend does not
maintain a separate template-string implementation.

Object literals use Oilpan-managed records. Static, shorthand, numeric, nested,
and computed properties share one runtime representation; object spread copies
properties in source order, so later entries overwrite earlier entries. Dot and
computed reads and writes, compound and update assignments, optional reads,
`in`, and `delete` all use the same property descriptor lowering and preserve
single receiver/key evaluation. Record fields trace managed strings and nested
records with Oilpan `Member` edges, while values held by generated C++ stack code
remain `Persistent` roots.

Structurally compatible records can cross interface boundaries.
The emitter creates a small Oilpan-managed adapter for each such interface, with
virtual property access bridged back to the record. This applies both to typed
variable initializers and call arguments. Callable fields and object-literal
methods use the same dynamic callable representation.

Class calls and explicit `new Class(...)` use one generated construction path, so
runtime injection, named arguments, defaults, and Oilpan allocation cannot drift.
Typed arrows and anonymous function expressions likewise share one native-lambda
emitter and root captured generated objects using the existing capture policy.
Contextually inferred callback parameters, including brace-lambda `it`, emit as
C++ generic-lambda parameters so collection callbacks do not require redundant
source annotations.

Synchronous class operator methods support unary `+`/`-`, binary overloads,
compound assignment through the corresponding binary overload, comparisons
derived from `operator<=>` or `operator==`, and `operator[]`/`operator[]=` with
one or more indices. The analyzer records the exact selected declaration for each
operator expression; C++ emission consumes that resolution instead of repeating
overload matching. JavaScript and C++ operator definitions share the runtime-name
mangler in `operatorNames.ts`, and compound-assignment mapping lives in the shared
AST layer. Compound assignment evaluates its target once before invoking and
storing the overload result.

Async and sync callables lower to C++20 task coroutines. They execute immediately
through their first pending `await`, suspend without blocking the event loop, and
resume as a microtask when the awaited task settles. Task continuations preserve
Oilpan pointer results through `Persistent` storage. `Promise.resolve`,
`Promise.reject`, `then`, `catch`, `finally`, `Promise.all`, `Promise.race`,
`Promise.allSettled`, and `Promise.any` share this task
state; callbacks returning another task are flattened. Top-level `await` still
drives the event loop synchronously through the generated entrypoint's `.get()`.

Native collection helpers include array `push`/`pop`/`shift`/`unshift`,
`includes`, `indexOf`, `lastIndexOf`, `at`, `join`, `reverse`, `slice`, `splice`,
`concat`, `fill`, `copyWithin`, `map`, `flat`, `flatMap`, `filter`, and `reduce`,
plus `forEach`, `some`, `every`, `find`, `findIndex`, and `sort`. String values
support casing and trimming plus `includes`, `startsWith`,
`endsWith`, `charAt`, `substring`, `slice`, and `split`. `Object.keys` and
`Object.values` enumerate managed records. These calls retain their analyzed
element/result types and reuse the same native lambda emitter as user callbacks.
Native array `toString`, `String(array)`, and console methods share one bracketed
representation such as `[1, 2, 3]`, including arrays reached through traced class
fields or persistent coroutine/callback roots.
`ArrayObject<T>` is the canonical implementation of this API: mutation,
searching, slicing, concatenation, higher-order operations, joining, and string
conversion live on the managed class. The emitter-facing free functions are
thin adapters that only normalize handles and inject the active runtime for
operations that allocate another managed array.
As in JavaScript, `map`, `filter`, `forEach`, `some`, `every`, and `findIndex`
callbacks may receive `(value, index, array)`. `reduce` callbacks may receive
`(accumulator, value, index, array)`. Shorter callback signatures remain valid,
and every method receives the original managed array as its receiver argument.
`concat` accepts the JavaScript forms in one call: individual element values,
other arrays, or any mixture of both. Each array argument contributes its
elements, while scalar arguments append one element.
`sort()` mutates and returns the same managed array using JavaScript-style
lexical string ordering. Passing a numeric comparator such as
`values.sort((left, right) => left - right)` selects comparator ordering.
Only reusable numeric range expressions keep an internal `std::vector`; that is
an eager iteration value, not the representation of a VexaScript array.

Native builds follow transitive local `.vx`, `.ts`, and `.tsx` imports through
the same resolver and project import mappings used by JavaScript module graphs.
Dependencies are analyzed and emitted once in dependency order into one C++
translation unit, so top-level initialization happens before the importing
module. Per-module native symbol identity prevents private-name collisions.
Named, aliased, default, namespace, re-export, and side-effect imports are
supported, as are configured project-directory entrypoints and output folders.

Generated classes support concrete and abstract single inheritance. Non-final
bases expose virtual trace and method dispatch, derived classes delegate tracing
to their base, abstract methods become pure virtual methods, overrides use C++
virtual dispatch, and `super.member` calls use qualified base calls. A class can
also implement multiple emitted interfaces, including property bridges for each.
TypeScript-style constructors and VexaScript primary constructors share the same
Oilpan allocation path. Derived constructors forward analyzer-ordered arguments
through `super(...)`, including hidden runtime propagation, so a generated base
class no longer needs a default constructor. Constructor parameter properties
are initialized after the base and traced when they contain managed values.

## Native standard library inventory

The native surface is an audited subset of `compiler/runtime/es2025.d.ts`:

- `ArrayObject<T>` owns array identity, tracing, indexed mutation, iterators, and
  the common search, copy, and higher-order methods listed above, including the
  ES2023 immutable-copy methods (`findLast`, `findLastIndex`, `toReversed`,
  `toSorted`, `toSpliced`, and `with`).
- `Map`, `Set`, `WeakMap`, and `WeakSet` use managed storage. Weak collection keys
  use Oilpan weak edges; `Map` and `Set` preserve insertion order and SameValueZero
  lookup behavior. ES2024 `Map.groupBy` and ES2025 set algebra and relation
  methods are implemented for native collection types.
- `Object.groupBy` groups native iterables into managed records. `Promise.try`
  and `Promise.withResolvers` use the same `Task<T>` settlement path as the
  existing promise combinators.
- `JSON.parse` supports objects, arrays, primitives, escapes, UTF-16 surrogate
  pairs, and deterministic insertion-order records. `JSON.stringify` supports
  dynamic native value graphs and rejects cycles.
- `Date` supports current time, numeric and ISO date-only construction,
  `Date.now`, `Date.parse`, UTC getters, numeric comparison, ISO formatting, and
  JSON formatting.
- `performance.now()` maps to a monotonic `std::chrono::steady_clock` timestamp,
  matching the high-resolution clock contract used by Node.js and browsers.
- `ArrayBuffer`, `Uint8Array`, and `DataView` share one backing buffer. Integer,
  float32, and float64 DataView reads and writes honor endianness. Resizable
  buffers expose `maxByteLength`, `resizable`, `detached`, `resize`, `transfer`,
  and `transferToFixedLength`.
- `String.at`, `String.replaceAll`, `String.isWellFormed`,
  `String.toWellFormed`, and `RegExp.escape` preserve the declaration surface's
  UTF-16 and literal-escape behavior.
- `Float16Array` supports construction, `of`/`from`, indexed access, its full
  callback/search/copy/sort surface, typed-array iterators, `set`, string
  conversion, and half-precision conversion at the shared backing-buffer
  boundary. `DataView` float16 access uses the same conversion. ES2025 `Iterator.from` and the map,
  filter, take, drop, flatMap, reduce, terminal, and search helpers consume
  native iterators once and preserve callback order.
- `Intl.DurationFormat` supports the native short, long, narrow, and digital
  formatting subset, including `formatToParts` and `resolvedOptions` records.
  `SharedArrayBuffer` growth and the standard `RegExp` flag accessors are
  represented by the same managed backing storage and value model. The native
  `Int32Array`/`BigInt64Array` paths also expose `Atomics.waitAsync`'s
  synchronous result shape.
- Dependency-free `BigInt` supports signed decimal plus `0x`, `0o`, and `0b`
  string input, arithmetic, power, bitwise operations, and shifts.

APIs outside this inventory are not guessed from a member name. The emitter
produces a targeted diagnostic for unsupported constructors, methods, argument
shapes, open generic types, non-native package dependencies, and unrepresentable
dynamic conversions.

## Async I/O and shutdown

Timers, promise continuations, async generators, and native I/O all resume via
the runtime's single microtask path. `readTextFile(path)` is the first platform
adapter: file bytes are read on a background standard-library task, while
settlement and managed-string allocation occur on the runtime thread. The event
loop polls pending I/O without allowing a distant timer to starve it. Runtime
shutdown cancels timers and discards queued callbacks and I/O pollers before
destroying the Oilpan heap, so no callback resumes against a destroyed runtime.

Promise resolution recursively assimilates nested native tasks. Rejections keep
arbitrary `vexa::Value` reasons through continuations and combinators; ordinary
C++ failures become managed error messages at the runtime boundary.

## Packages and native bindings

Native module resolution reuses the normal project resolver and accepts packages
whose resolved entry and transitive dependencies are compilable `.vx`, `.ts`, or
`.tsx` source within the supported native surface. A package that resolves only
to JavaScript is rejected explicitly because JavaScript binaries cannot be linked
into the C++ translation unit.

Native-only libraries may ship a VexaScript/TypeScript declaration facade using
the C++ binding or dynamic-library annotations described below. Package identity,
aliases, defaults, namespace imports, re-exports, and project mappings remain on
the shared resolver rather than a native-only package map. The published package
includes the complete `native/runtime/` source directory and the vendored Oilpan
and mimalloc archives required by native executable builds.

## Diagnostics and sanitizer mode

Generated translation units emit `#line` directives and update the runtime's
current VexaScript source location before source statements. C++ compiler
diagnostics therefore name the originating `.vx` file, including dependency
modules, and an uncaught native exception reports `file:line:column` before the
runtime exits with status 1.

Set `VEXA_NATIVE_DEBUG=1` to compile generated programs with debug symbols. Set
`VEXA_NATIVE_SANITIZERS=1`, or run `pnpm test:native:sanitized`, to build the
native smoke with AddressSanitizer and UndefinedBehaviorSanitizer, debug symbols,
and frame pointers. Set `VEXA_NATIVE_GC_STRESS=1` to force an Oilpan collection
after each small batch of source-statement safe points. `pnpm test:native:stress`
runs that mode across the complete native smoke, including dynamic cycles,
closures, promises, tasks, and generators. Sanitizer and forced-collection runs
remain separate because macOS ASan's instrumented stack is not compatible with
Oilpan's forced conservative stack scan. The bundled executable workflow is
tested on macOS and Linux; Windows remains an explicit future portability target.

Run `pnpm benchmark:native` to compile the same source to native C++ and
JavaScript, then compare startup, total workload, array, bigint, and event-loop
execution against Node.js. It also measures native compile time, binary size,
and forced-GC execution. Recorded results live in
`docs/native-benchmarks.md`; they are informational baselines rather than
cross-machine pass/fail thresholds.

## Native source bindings and dynamic libraries

Signature-only functions may provide trusted raw integration metadata through
`@CppHeader`, repeated `@CppFlags`, and `@CppBody`. Headers are emitted before
the shared runtime include, bodies retain the analyzed VexaScript signature, and
flags flow from the native module graph to `g++` as separate arguments. Modules
that are not reachable from the entrypoint do not contribute binding metadata.

An ambient class annotated with `@FFILibrary("path", ...)` describes a dynamic
C ABI. Candidate DLL, shared-object, dylib, or framework paths are tried in
source order. The native runtime caches successful library handles and generated
methods cache their resolved symbols. `@FFIName("symbol")` may override a C
symbol name; otherwise the VexaScript method name is used. The JavaScript emitter produces the same
class surface backed by `Deno.dlopen`; other runtimes can provide
`globalThis.VexaFFI.open`. `@FFIStruct`, `@FFIAlign`, `@FFIOffset`, and
`@FFISize` generate one validated `ArrayBuffer`-backed memory layout for both
targets. Layout views may be constructor parameters or ordinary instance
fields, and explicit offsets may overlap for C union-style data. Raw
`ArrayBuffer` parameters pass their backing bytes to the symbol without a copy.
`FFIPointer` exposes arbitrary numeric reads and writes over opaque
addresses. A `Promise<T>` symbol runs on Deno's nonblocking FFI pool or a native
C++ worker, then settles on the main Vexa event loop. The `samples/ffi-sdl2/`
sample demonstrates raw C++ bindings and the complete cross-backend form.

## Explicit rejection inventory

The backend currently rejects these shapes before producing C++:

- generic or generator function expressions (named generic/generator declarations
  are supported), non-literal parameter defaults, untyped native callable
  parameters, and unsupported return annotations;
- sparse arrays whose element representation is not dynamic, arrays with no
  single representable element type, non-array/non-generator `for-of` sources,
  and typed-array compound index assignments;
- construction of runtime values outside the generated classes and the documented
  collection, Date, and binary types; iterable collection constructors whose
  source cannot be represented as a native array;
- Date component/local-time constructors and setters, JSON replacer/reviver/space
  arguments, and standard-library methods outside the inventory above. The
  ES2025 `Float16Array`, iterator helpers, `Intl.DurationFormat`, growable
  `SharedArrayBuffer`, and regular-expression flag accessors are included in
  the native inventory; unrelated standard-library declarations remain subject
  to the rejection branches above;
- ambient or string-valued enums, class delegation, static/abstract/computed/
  optional class fields, async accessors, and async/operator methods;
- computed, accessor, or generic interface method forms that cannot be represented
  by the current virtual contract (ordinary optional methods and properties are
  supported);
- delete targets other than managed record/dynamic properties and dynamic casts
  whose source value has no trace-safe native representation.

Each case is owned by an explicit `CppEmitError` branch and reported as a source
diagnostic. Analyzer-selected calls, implicit `this`, operators, extension
properties, generic arguments, and assignability are consumed from semantic maps
rather than re-decided by these rejection checks.
