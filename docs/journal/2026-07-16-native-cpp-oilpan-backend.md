# Native C++ and Oilpan backend

## Context

The compiler previously treated JavaScript emission as the only terminal step.
Adding native output exposed an important phase-boundary requirement: a second
backend should reuse parsing, semantic analysis, diagnostics, and lowering,
without importing Node-only build concerns into browser-compatible compiler
modules.

## What worked

The C++ emitter is a browser-compatible compiler module selected only after the
normal compilation artifacts have passed diagnostics. Range loops reuse the
existing lowering pass, so `for (n of 0 ..< 10)` has one lowering rule shared
with optimized JavaScript output rather than a second interpretation in the C++
backend.

Oilpan extraction, CMake invocation, `g++` selection, and native linking live in
a CLI-only adapter. This preserves the compiler's browser compatibility and
keeps all process and filesystem work asynchronous. A dedicated `build-vexa`
CMake directory prevents collision with an Oilpan checkout's ordinary build
cache.

The direct `native` command keeps its generated translation unit under
`<source>.build/main.cpp` and accepts a separate executable output path. Oilpan
sources and its CMake build live in a versioned OS temporary cache, so neither
the source directory nor the packaged `native/` asset directory accumulates
toolchain intermediates.

The minimal regression test was written before the emitter option existed. It
first failed at the public `TranspileOptions` boundary, then covered the exact
lowered loop and console call. The runnable sample remains broad coverage, and
the decisive validation compiled and ran the produced executable.

A second validation deliberately allocated a runtime string. The numeric-only
sample linked successfully, but the string program initially failed with an
undefined `EnsureGCInfoIndex` symbol. CMake's Oilpan target exposes cppgc compile
definitions as `PUBLIC`; a direct `g++` consumer does not inherit target
properties. Passing `CPPGC_IS_STANDALONE`,
`CPPGC_ENABLE_OBJECT_SECTION_GCINFO`, and `V8_LOGGING_LEVEL` to the final
translation unit fixed the mismatch. A pure argument-builder regression now
keeps those consumer definitions visible.

The first object-oriented native sample exposed a second backend boundary:
JavaScript class calls are normally rewritten to `new` using analysis context,
but the small C++ emitter owns its allocation model. Primary-constructor
classes are now emitted as `cppgc::GarbageCollected<T>` objects, constructor
calls allocate through `Runtime::make<T>`, and known GC object locals use C++
pointer member access. Keeping allocation behind the runtime avoids embedding
heap-handle mechanics at every generated call site.

The first generated range loop also revealed a type-erasure shortcut: its
initializer was always declared as `double`, even though VexaScript already
distinguishes `int`, `long`, and `number`. The lowering pass preserves the
original range-bound expression nodes, so the C++ backend can consume the same
analysis type map as the JavaScript backend. Native loops now map `int` to
`std::int32_t`, `long` to `std::int64_t`, and `number` to `double`; AST literal
kinds remain only a fallback when no analyzed type is available.

Arrays reinforced the same lesson. Emitting every literal through a dynamic
container would erase the element types the analyzer already knows, while C++
class template argument deduction cannot represent empty or heterogeneous
JavaScript-style arrays reliably. The backend now maps analyzed homogeneous
array and tuple element types to `std::vector<T>`, keeps unsupported element
types explicit errors, and provides a small runtime `push` helper so the
generated call retains JavaScript's returned length. Indexed access and
iteration stay ordinary C++ operations, while the `length` property is emitted
as a numeric `.size()` conversion. Subsequent array APIs follow the same shared
runtime route: `includes` uses SameValueZero semantics, `indexOf` keeps strict
equality semantics, `join` shares the primitive string conversions, and
`reverse` mutates and returns the original native vector.

Custom functions and class methods exposed a calling-convention issue: string
literals and class allocation require access to the active heap, but free C++
functions and inline methods do not naturally see the `Runtime` local in
`main`. The emitter now gives every generated callable one hidden
`vexa::Runtime&` parameter and injects it at direct, instance, and implicit
method call sites. One signature builder owns parameter and return-type mapping
for both functions and methods. Forward class declarations and function
prototypes allow functions to call later functions and accept class pointers,
while definitions are ordered after complete class declarations.

The same change made implicit receiver handling explicit in the small backend.
Within a method, primary-constructor fields and sibling methods resolve through
`this` unless a parameter or local shadows the name. GC object locals and class
parameters now share one name-to-class map, which controls both `->` member
access and method signature lookup instead of maintaining parallel boolean and
type caches.

Default arguments stay in the same call-routing path. Instead of emitting C++
declaration defaults—which cannot safely allocate runtime strings and do not
match VexaScript named-argument reordering—the backend fills omitted literal
defaults at each generated call site. This works uniformly for top-level
functions, instance methods, static methods, and primary constructors. More
complex defaults remain explicit errors because defaults that reference earlier
parameters require callee-scope substitution rather than caller-scope emission.

Static methods reuse the callable signature and runtime convention but emit
with C++ `static` and are invoked through `Class::method`. A static factory's
analyzed class return type feeds the same name-to-class tracking used by direct
constructors, so its result immediately supports instance `->` access without a
parallel factory-specific path. Explicit return types also make recursive
function prototypes valid, while no-value functions safely infer C++ `void`.

The first implicit-member implementation inferred `this` again inside the C++
emitter from class field/method names plus a local-name set. That duplicated a
semantic decision already made by the analyzer and risked drifting from JavaScript
emission, especially around shadowing and static receivers. The C++ backend now
consumes the same `getImplicitReceiverIdentifiers()` and
`getStaticImplicitReceiverIdentifiers()` results as the JavaScript backend. The
only backend-specific decision is target spelling: `this.` in JavaScript versus
`this->` or `Class::` in C++.

Timers and async callables also reinforced why the runtime should remain an
explicit owned object. `Runtime` now owns one single-threaded queue for timer
events and microtasks. Generated `main` drains it before Oilpan shutdown, while
`Task<T>::get()` pumps the same queue until its state settles. This avoids a second
task scheduler with different ordering rules and makes `sync` auto-await reuse the
analyzer's existing `autoAwaitExpressions` set rather than rediscovering Promise
expressions in the C++ emitter.

Queued callbacks cannot leave generated Oilpan objects as untraced raw pointers in
native heap closures. Async method receivers and captured generated class values
are therefore copied into `cppgc::Persistent` roots before the microtask or timer
callback is stored. Top-level timer callbacks may safely capture by reference
because the generated entrypoint drains the queue before its stack frame exits.

This first task lowering schedules a whole async/sync callable body as one
microtask. It supports task production, explicit `await`, `sync` auto-await, `go`,
Promise-return annotations, task flattening, and exception propagation, but does
not yet transform each individual `await` into a continuation boundary. That
limitation is documented rather than hidden behind JavaScript-looking output.

The source `Promise { resolve, reject -> ... }` form initially exposed another
tempting split: a separate native Promise class with its own queue. Instead,
Promise construction is a source-level facade over the same `Task<T>` settlement
state used by async/sync functions. Its executor runs immediately, resolver and
rejecter handles share a first-settlement-wins state, timers store those handles as
ordinary safe callbacks, and `Task<T>::get()` remains the single waiting path.
Inferred return types come from the analyzer's callable type map; the C++ emitter
does not independently decide that an expression-bodied `delay` function returns
a Promise.

Generators extended that same rule beyond top-level symbols. The analyzer already
resolves plain generators to `Generator<T>` and async-capable generators to
`AsyncGenerator<T>`, including class methods. Exposing one callable-node type map
lets the C++ signature builder consume those results without re-inferring yield
types or maintaining separate top-level and method lookup paths.

C++20 coroutines provide the native lazy suspension model directly. One
`BasicGenerator<T, Async>` implementation owns frame resumption, yielded and final
values, exceptions, `.next()`, and range iteration; the synchronous and
async-capable aliases differ only in whether `.next()` returns an immediately
awaitable result. `yield*` remains emitter syntax lowering, but all delegated
values go through one typed runtime conversion helper so dynamic strings enter
the same Oilpan-backed `Value` representation as direct string expressions.

Coroutine frames are ordinary C++ allocations and are not traced by Oilpan.
Keeping raw generated-object pointers in parameters, method receivers, locals, or
yield slots would therefore create suspension-time collection hazards. Generated
coroutine bodies install `cppgc::Persistent` roots for incoming objects and method
receivers, generated-object locals use persistent storage, and the shared
generator task storage roots yielded and returned pointer values. The native
compile-and-run fixture deliberately resumes the same yielded object after a
mutation and delegates managed strings to cover these lifetime boundaries.

Resuming a `yield` expression required more than returning `std::suspend_always`.
The promise now returns one awaiter that reads the next supplied value from rooted
task storage. `next(value)` only installs that input after the coroutine has
started, preserving JavaScript's rule that the first input is ignored. Source
`.return()` is routed to a non-keyword native `finish()` method, which destroys the
frame immediately and returns a completed iterator result.

Mixed arrays revealed a shared inference defect rather than a C++-only problem.
After two incompatible elements produced `any`, the next element could narrow the
common type again because `any` is assignable to everything. `commonSupertype`
now treats `any` as an absorbing result, so `[1, "x", true]` remains `any[]` in
every backend. Native mixed primitive arrays map that type to
`std::vector<vexa::Value>`. Array insertion/query arguments and delegated yields
share one `convertValue` helper, avoiding separate dynamic-string conversion
rules that could drift.

Object-valued primary-constructor fields exposed a different Oilpan boundary from
locals and coroutine frames. A pointer stored inside a garbage-collected object
must be an interior `cppgc::Member<T>`, not a `Persistent` root and not a raw
pointer. Generated classes now derive their field storage and `Trace` calls from
the same declared class type used by constructor signature mapping. Primitive
fields remain untraced, while every generated-object field is visited by one
generated trace method.

Native switch support started with direct integral C++ switches. Managed strings
cannot be C++ case labels, and repeating the discriminant in an if-chain would
change side effects. The general path therefore evaluates the discriminant once,
selects a numeric case index through an ordered equality chain, and reuses one
case-body emitter for the final C++ switch. Using a real `default` label for the
source default also lets the C++ compiler see exhaustive value-returning switches
without warnings or undefined fallthrough paths.

Exceptions and cleanup reuse shared lowering as well. Every source throw enters
one `throwValue` normalization path, catch parameters receive a managed message,
and one move-only RAII guard implements finally-on-scope-exit. Because `defer` is
already lowered to `try/finally` before either backend emits code, it became native
without a second defer interpretation. Control flow originating inside `finally`
is rejected explicitly: a destructor callback cannot safely reproduce JavaScript's
return/throw override rules, especially during exception unwinding.

Ordinary class fields reuse the same declared-type mapping and tracing path as
primary-constructor properties. Classes with field initializers receive the hidden
runtime in their generated constructor, which lets managed strings and nested
generated objects be initialized without a global runtime. Object fields remain
interior `Member` references and contribute to the same generated `Trace` method.

Reusable range expressions cannot use the allocation-free loop rewrite because
their value may outlive and be traversed independently of the original expression.
They therefore map the analyzer's existing `range<T>` type to `std::vector<T>` and
share one runtime constructor, while direct range loops retain their existing
lowering. Comma expressions are emitted structurally. Nullish coalescing needs a
callback-based helper rather than a normal function argument: eagerly passing the
right operand would silently violate source evaluation order. Both the dynamic
value and generated-object pointer overloads use that same lazy callback contract.

## Investigation notes and rejected paths

Putting source extraction and `g++` directly in the transpiler would have been
shorter, but it would introduce Node APIs into a compiler module used by browser
embeds. It was rejected in favor of a compiler/backend boundary plus a
Node-only CLI build adapter.

A static application runtime was considered as a way to avoid the hidden
parameter. It was rejected because `Runtime` owns process initialization and the
Oilpan heap: global initialization order, shutdown order, and test isolation
would become implicit. Passing the runtime in generated C++ keeps the public
VexaScript syntax unchanged while preserving an auditable lifetime.

Generating an absolute include path to `native/runtime.cpp` would make a local
build work but would make emitted C++ machine-specific. Generated code instead
includes `runtime.cpp` by name, while the native linker supplies the packaged
`native` include directory.

Treating unsupported JavaScript constructs as pass-through C++ was also
rejected. The initial backend is deliberately small and reports a compilation
error for unsupported AST kinds; this avoids producing plausible-looking but
incorrect native programs.

## Regression risks

- New language lowering must stay backend-neutral when possible; adding a
  C++-only interpretation of an existing construct would reintroduce drift.
- Runtime-owned Oilpan roots must be destroyed before the `Runtime` heap. The
  generated `main` declares `Runtime` first so later values are destroyed first
  by C++ reverse destruction order.
- GC object member access uses one name-to-class map seeded by parameters,
  initializers, and shared expression analysis. Future inheritance and container
  fields must preserve that same source of truth.
- Array support deliberately depends on one representable native element type.
  Heterogeneous, sparse, and spread arrays need a deliberate dynamic
  value/container design instead of relying on C++ deduction or silent coercion.
- Packaged CLI releases must continue including both `native/runtime.cpp` and
  `native/oilpan-standalone-main.zip`.
