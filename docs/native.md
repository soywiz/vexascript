# Native C++ backend

VexaScript can emit a C++ translation unit from a single source file:

```sh
vexa cpp main.vx
```

The default output is `main.cpp`; `-o <file>` selects another C++ output path.
`vexa build main.vx --emit cpp` remains available as the equivalent compatibility
form. To compile directly to a native executable, use:

```sh
vexa executable main.vx
./main
```

The intermediate C++ file is written to `main.vx.build/main.cpp`. Use
`--build-dir <dir>` to select a different intermediate directory and
`-o <file>` to select the executable path. `vexa native main.vx` and
`vexa build main.vx --native` remain compatibility forms of this workflow.

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

The end-to-end regression lives in `samples/native-language-smoke/`. It is a
multi-file program covering functions, classes, interfaces, operators, managed
arrays and records, control flow, exceptions, generators, promises, timers, and
local imports. `cli/nativeSmoke.test.ts` compiles it through the public
`executable` command, runs the resulting process, and compares its complete
stdout with `expected.native.txt`. The ordinary sample harness separately runs
the same entry through JavaScript and compares it with `expected.txt`.

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
grade-school and its division is deliberately bit-at-a-time: the initial
implementation favors correctness and no dependencies over speed. Range-loop
iterators use the analyzed element type rather than a single hard-coded numeric
type. Numeric remainder uses the shared native
`remainder` helper, preserving integral `%` behavior while mapping `number`
operands to `std::fmod` instead of emitting invalid C++ floating-point `%`.

The runtime lives entirely in `native/runtime.cpp`. It initializes an actual
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
  the common search, copy, and higher-order methods listed above.
- `Map`, `Set`, `WeakMap`, and `WeakSet` use managed storage. Weak collection keys
  use Oilpan weak edges; `Map` and `Set` preserve insertion order and SameValueZero
  lookup behavior.
- `JSON.parse` supports objects, arrays, primitives, escapes, UTF-16 surrogate
  pairs, and deterministic insertion-order records. `JSON.stringify` supports
  dynamic native value graphs and rejects cycles.
- `Date` supports current time, numeric and ISO date-only construction,
  `Date.now`, `Date.parse`, UTC getters, numeric comparison, ISO formatting, and
  JSON formatting.
- `ArrayBuffer`, `Uint8Array`, and `DataView` share one backing buffer. Integer,
  float32, and float64 DataView reads and writes honor endianness.
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

Native-only libraries should currently ship a VexaScript/TypeScript declaration
and source facade that calls supported runtime primitives; there is not yet a
stable user-defined C ABI annotation. This source-package contract keeps package
identity, aliases, defaults, namespace imports, re-exports, and project mappings
on the shared resolver instead of introducing a native-only package map. The
published package includes `native/runtime.cpp`, `native/bigint.h`, and the
vendored Oilpan archive required by both `cpp` and `executable`.

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

Run `pnpm benchmark:native` to measure native compile time, binary size, startup,
array and bigint workloads, event-loop latency, and forced-GC execution. Recorded
results live in `docs/native-benchmarks.md`; they are informational baselines
rather than cross-machine pass/fail thresholds.

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
  arguments, and standard-library methods outside the inventory above;
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
