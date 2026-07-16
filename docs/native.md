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
- typed top-level functions, including forward calls, named-argument reordering,
  literal default arguments, recursion, inferred `void` returns, class-instance
  parameters, calls from other functions or methods, and `async`/`sync` functions
  represented as native `Task<T>` values;
- concrete classes whose primary-constructor properties and initialized instance
  fields use primitive types or other generated classes, including construction,
  explicit `new` construction, property access, synchronous typed instance and
  static methods, static factory methods that return class instances, and
  `async`/`sync` methods, plus synchronous class operator overloads;
- homogeneous arrays with a supported native element type and mixed primitive
  arrays represented by managed dynamic values, including literals, indexed
  reads and writes, `length`, `push`, `includes`, `indexOf`, `join`, `reverse`,
  and synchronous `for-of` loops;
- range-based `for` loops lowered to native C++ loops and reusable inclusive or
  exclusive range expressions backed by typed native vectors;
- `if`, `while`, `do while`, integral and value-based `switch`, return, break,
  continue, `throw`, `try`/`catch`/`finally`, and `defer` statements;
- arithmetic and managed string concatenation, comparison including `<=>`, array
  and range membership, assignment, truthy logical/unary conditions, update,
  conditional, comma, and lazy nullish-coalescing expressions;
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
`double`. Range-loop iterators use the analyzed element type rather than a
single hard-coded numeric type.

The runtime lives entirely in `native/runtime.cpp`. It initializes an actual
cppgc heap, represents dynamic `vexa::Value` strings as
`cppgc::GarbageCollected` objects, keeps live dynamic strings rooted with
`cppgc::Persistent`, and allocates generated class instances through the same
Oilpan heap. Homogeneous string arrays use owned `std::string` elements and
normal C++ lifetime management rather than Oilpan tracing. Mixed primitive array
literals infer `any[]`, use `std::vector<vexa::Value>`, and convert every inserted
or queried value through the runtime so strings retain their managed roots.
Generated objects stored in another generated object's primary-constructor or
ordinary instance fields use `cppgc::Member<T>` and are visited by the owner's
generated `Trace` method. Field initializers that allocate managed strings or
objects use the hidden runtime passed to the generated constructor.

Generated functions and methods receive the active runtime through a hidden C++
parameter. VexaScript call sites remain unchanged. This keeps heap ownership and
destruction order explicit without introducing a process-global application
singleton. Function and method parameters require supported type annotations;
value-returning callables also require an explicit return type. Literal defaults
are lowered into generated call sites rather than C++ declaration defaults.
Extension, generic, and accessor callables remain unsupported.

Both JavaScript and C++ emission consume the analyzer's resolved implicit-receiver
identifier sets. The analyzer decides whether an unqualified identifier means a
local, an instance member, or a static member; each backend only chooses its target
spelling (`this.member`, `this->member`, or `Class::member`). The C++ emitter does
not repeat field-name or local-shadowing inference.

Native `async` and `sync` calls enqueue their callable body as a microtask on the
same `Runtime` that owns timers. `await` waits for a `Task<T>` while pumping that
event loop, `sync` uses the analyzer's existing auto-await set, and `go` retains the
task without waiting. Both `Promise<T>` annotations and VexaScript's shorthand
non-Promise async return annotations map to `Task<T>`. Returning another task from
an async callable is flattened.

Source-level `Promise` construction does not create a parallel runtime object or
scheduler. The C++ emitter lowers its executor to `Task<T>::create`; the executor
runs immediately, while its `resolve` and `reject` handles retain shared settlement
state and may safely be passed to `setTimeout`. An unparameterized `Promise` uses
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
matching the usual timer lifecycle. Timer callbacks currently support synchronous,
zero-argument functions and arrows. Top-level arrows capture entrypoint locals by
reference; arrows created inside a callable capture ordinary values by value and
root captured generated class objects with `cppgc::Persistent`.

Integral and boolean switches emit direct C++ `switch` statements. Other
comparable discriminants, including managed strings and dynamic values, are
evaluated once and mapped to a native case index before entering a C++ switch;
this preserves source case-expression order, fallthrough, and defaults without
duplicating the discriminant expression.

Source throws are normalized through `throwValue` into native exceptions. Catch
bindings receive the exception message as a managed VexaScript string. `finally`
uses a move-only RAII guard, so it runs for normal completion, return, or exception;
the shared lowering means `defer` uses exactly the same path. A native `finally`
block currently rejects `return`, `break`, `continue`, and `throw`, whose JavaScript
override semantics cannot be represented safely by a destructor callback.

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

Class calls and explicit `new Class(...)` use one generated construction path, so
runtime injection, named arguments, defaults, and Oilpan allocation cannot drift.
Typed arrows and anonymous function expressions likewise share one native-lambda
emitter and root captured generated objects using the existing capture policy.

Synchronous class operator methods support unary `+`/`-`, binary overloads,
compound assignment through the corresponding binary overload, comparisons
derived from `operator<=>` or `operator==`, and `operator[]`/`operator[]=` with
one or more indices. The analyzer records the exact selected declaration for each
operator expression; C++ emission consumes that resolution instead of repeating
overload matching. JavaScript and C++ operator definitions share the runtime-name
mangler in `operatorNames.ts`, and compound-assignment mapping lives in the shared
AST layer. Compound assignment evaluates its target once before invoking and
storing the overload result.

The initial task lowering executes each async/sync callable body as one microtask;
it does not yet split a body into continuations at every `await`. Consequently,
statements before a callable's first `await` begin when its queued microtask runs,
rather than synchronously at the original call as in JavaScript.

Native emission currently supports single-file builds only and cannot be
combined with `--bundle` or project-directory builds.
