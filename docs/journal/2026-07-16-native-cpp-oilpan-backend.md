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

Arrays reinforced the same lesson, but the first representation was incomplete.
The backend initially mapped analyzed arrays to `std::vector<T>`, which preserved
element types but silently introduced C++ value semantics: assignment, function
parameters, and two object constructors duplicated the contents. It also left
generated-object pointers inside vector-valued fields outside Oilpan's traced
object graph. A focused regression with two holders sharing one array exposed
the copy directly before the fix.

Language arrays now use `ArrayObject<T>`, an Oilpan-allocated backing object.
Locals and parameters carry one pointer, generated fields carry a traced
`cppgc::Member<ArrayObject<T>>`, and suspended/captured arrays receive the same
`Persistent` rooting treatment as generated objects. Element storage is selected
once by `ArraySlot`: primitives and owned strings are ordinary values, generated
object pointers become traced `Member` edges, and dynamic values reuse
`StoredValue`. This preserves identity and allows unreachable cycles to be
collected; using `shared_ptr<vector<T>>` was considered but rejected because an
array/object cycle would require permanent roots for its Oilpan elements and
would leak. Only numeric range materialization remains an internal vector.

Indexed access, iteration, and collection methods now share the managed-array
helpers. Array-producing APIs receive the active runtime and allocate a new
backing object; mutating APIs retain the original identity. The decisive native
validation stored the same array in two holders, mutated through both, and
printed `9 9,2,3`. Additional compile-and-run checks covered mixed values,
managed-object elements, destructuring, `map`/`filter`/`slice`, `Promise.all`, and
an array retained across generator suspension.

The first console overload for managed arrays accepted
`const ArrayObject<T>*`. For a raw `ArrayObject<T>*`, C++ preferred the generic
`const T&` printer because it avoided the pointer-to-const qualification
conversion, so console output exposed an address such as `0x1048a08c0`. Making
the pointer overload exact and routing it through the array's real `toString`
fixed the symptom and unified direct pointers, interior `Member` handles, and
`Persistent` roots behind the same bracketed formatter. The timer/map/filter
reproduction now prints `after one second [6, 12]`.

That formatting bug also exposed an architectural smell: `ArrayObject<T>` owned
storage and tracing while free runtime helpers owned most visible Array behavior.
The managed class is now the canonical native API for mutation, lookup,
`slice`/`concat`, `map`/`filter`/`reduce`, `join`, and `toString`. Existing free
functions remain only thin emission adapters, mainly to inject `Runtime&` into
methods that allocate a result array. This keeps one semantic implementation
without leaking GC allocation details into source-level method signatures.

Focused emitter assertions were not enough to prove this surface. The first
large native smoke program exposed that the real project declarations model
`concat` with `ConcatArray<T>`, while native lowering only accepted one array.
The analyzer now treats ordinary arrays as `ConcatArray<T>`, contextual union
element arrays remain managed dynamic arrays, and emission distinguishes scalar
arguments from array arguments before delegating to one variadic managed-class
implementation. The canonical `samples/native-language-smoke/` regression now
passes through the public `executable` CLI, links Oilpan, executes the binary,
and compares its complete output rather than only inspecting generated text.

Growing that executable smoke with ordinary collection code exposed another
emitter/runtime mismatch: semantic analysis already resolved `forEach`, `some`,
`every`, `findIndex`, and `sort`, but the C++ emitter fell through to JavaScript
member spelling such as `values.some(...)`, which is invalid for a managed
pointer and had no native implementation. These methods now live on
`ArrayObject<T>` with thin emitter adapters. Sorting deliberately copies element
handles to temporary C++ storage, orders them, and writes them back into the
existing traced slots, preserving the array's identity and its Oilpan edges.
Both default lexical ordering and numeric comparator ordering execute in the
multi-file native smoke.

Adding indexed predicates to that smoke exposed two related compatibility gaps.
The analyzer already gave higher-order callbacks their JavaScript signatures,
but the native managed-array methods invoked only the first one or two
arguments. One `invokeArrayCallback` path now supplies `(value, index, array)`
to `map`, `filter`, `forEach`, `some`, `every`, and `findIndex`, while the
corresponding reduce helper supplies `(accumulator, value, index, array)`;
compile-time invocability preserves shorter source signatures without separate
method implementations. The same test then reached `index % 2` with a
`number` index and revealed that direct C++ `%` is invalid for `double`.
Binary remainder emission now uses one runtime operation that preserves native
integral remainder and delegates floating-point operands to `std::fmod`.

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
Keeping raw generated-object or managed-array pointers in parameters, method
receivers, locals, or yield slots would therefore create suspension-time
collection hazards. Generated coroutine bodies install `cppgc::Persistent` roots
for incoming objects and arrays plus method receivers, managed locals use
persistent storage, and the shared generator task storage roots yielded and
returned pointer values. The native
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
`ArrayObject<vexa::Value>`. Array insertion/query arguments and delegated yields
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
and `defer` is already lowered to `try/finally` before either backend emits code.
The first implementation used a move-only RAII guard, but that path could not
reproduce the rule that a return or throw inside `finally` overrides an earlier
completion. The durable lowering stores the pending exception or internal control
signal, runs the cleanup as ordinary emitted code, and rethrows only when cleanup
finishes normally. Callable, loop, and switch boundaries convert return, continue,
and break signals back into C++ control flow. Pointer-valued returns use the same
rooted `TaskStorage` representation as tasks, so the pending value survives GC
during cleanup. This keeps one shared `try/finally` path for both explicit cleanup
and `defer` while preserving nested completion ordering.

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

Several expressions initially looked valid in emitted C++ but did not preserve
VexaScript runtime semantics. Managed strings cannot use C++ `operator+`, `NaN`
has different truthiness from an ordinary nonzero C++ value, and arrays are always
truthy even when empty. String/dynamic addition now shares one managed `add` path,
and every source condition routes non-native booleans through the existing
`Boolean` conversion. Logical `&&` and `||` retain C++ short-circuit evaluation
while returning the boolean type already established by the analyzer.

Primitive comparison and collection membership also reuse runtime primitives:
`<=>` and managed relational operands use one `compare` helper, while `in` over
an analyzed array/range calls the same `includes` implementation as the method
surface. Explicit `new` and class-call construction were collapsed into one
emitter helper so hidden runtime arguments and constructor defaults have one
source of truth. Parameterized arrows and anonymous function expressions now
share one native-lambda context, including local symbol tracking and generated
object parameter types, rather than growing separate callback paths.

Native operator overloading initially risked recreating the JavaScript emitter's
candidate search inside the C++ backend. The analyzer already knows the exact
selected declaration, so operator resolutions were expanded to cover direct and
derived binary comparisons, unary operators, compound assignments, and indexed
getters/setters. C++ emission maps those declaration nodes to generated class
methods and performs no independent overload matching. Derived `<=>` and `==`
behavior is also recorded by analysis, keeping comparison choice backend-neutral.

Operator definition names now come from one `operatorMethodRuntimeName` helper
used by both JavaScript and C++. The compound-assignment-to-binary mapping moved
to the shared AST layer and is consumed by analysis and both emitters. A native
`assignWith` helper binds the compound target once, calls the resolved overload,
and stores its result, avoiding duplicated side effects for member targets.

Native interfaces exposed a similar drift risk. Recomputing structural
assignability in the C++ emitter was unnecessary: analyzed receiver types already
identify the interface whose method signature supplies argument conversion, and
the analyzer already verifies each concrete implementation. The emitter now only
walks the declared single-interface inheritance chain to recover that signature,
then relies on C++ virtual dispatch for the concrete call.

Using an ordinary C++ abstract base compiled and dispatched correctly, but it was
not enough for interface-typed object fields or callback captures: Oilpan cannot
trace an erased concrete pointer through an unrelated base. Emitted root
interfaces therefore inherit `GarbageCollectedMixin`, inherited interfaces
delegate `Trace` to their base, and concrete classes delegate before tracing their
own `Member` fields. This keeps interface-typed `Member` and `Persistent` handles
valid without adding a parallel registry of concrete implementations.

Numeric enums did not require copying the type checker's constant evaluator into
the backend. They emit as `std::int32_t` constants whose automatic members refer
to the previous member and whose explicit expressions remain C++ constant
expressions. The emitter only validates and translates the supported expression
shape. Type aliases similarly recurse through the existing declared-type mapper;
declared array suffixes use the shared `splitArraySuffixTypeName` helper instead
of introducing another parser for `T[]` text.

Interface properties cannot be represented by ordinary C++ fields on an abstract
base. Each required property therefore emits a virtual getter and, when mutable,
a virtual setter. Implementing primary-constructor and regular fields receive
small bridge methods; assignability remains the analyzer's responsibility. The
assignment lowering evaluates the receiver once before its current value and
right operand, then returns either the new or previous value according to direct,
compound, prefix, or postfix source semantics. Local GC tracking now prefers an
explicit interface annotation over the concrete initializer so later member
access continues using the source program's static dispatch type.

Computed getters reuse the same callable emitter as ordinary methods. Concrete
property reads only add the hidden runtime argument, while interface conformance
adds the same virtual bridge already used by field-backed properties. Implicit
getter identifiers continue to come from the analyzer's shared implicit-receiver
set; the C++ backend only decides whether the selected class member is spelled as
a field access or a zero-source-argument method call.

Template strings needed no new native AST case. The tokenizer already lowers each
template into binary string additions, so extending the interface-property test to
`` `${meter.label}:${meter.value}:${meter.leaf.value}` `` exercised the existing
managed `vexa::add` path. This preserves JavaScript/C++ semantic sharing, performs
numeric string conversion in the runtime, and keeps the resulting string rooted
by Oilpan without a second interpolation implementation.

Setter accessors extend that same property path instead of adding special cases
for each assignment operator. One native property descriptor supplies the
receiver, getter name, and setter name for both concrete accessors and interface
bridges; direct, compound, prefix, and postfix lowering therefore keeps identical
single-evaluation and result semantics. The generated getter and setter are C++
overloads distinguished by the setter's value parameter.

Testing an implicit `value += 1` exposed a shared analysis bug: class checking
replaced the accessor property's symbol with each accessor's function type, and
getter shorthand was not consistently classified as a property in every member
resolver. Fixing Binder and TypeChecker made getter, setter, and getter-shorthand
members retain one property type for every backend. The C++ emitter still consumes
the analyzer's implicit-receiver set and only chooses native call spelling.

Adding dynamic objects exposed two distinct Oilpan ownership boundaries. Values
on the C++ stack must root strings and records with `Persistent`, but edges stored
inside a managed record must use `Member`; storing `Persistent` fields inside a
record would turn cycles into permanent roots. A separate traced stored-value
variant keeps that distinction explicit while presenting one `Value` API to
generated code.

Computed compound assignment initially emitted `recordGet<auto>`, because an
arbitrary runtime key has no statically selected property type. The durable rule
is that unknown computed reads cross the runtime boundary as `vexa::Value`, then
reuse dynamic addition and conversion helpers. The shared native property
descriptor also caches a computed key once before getter and setter calls, so
record properties and class accessors preserve the same evaluation order.

Structural interface compatibility cannot be represented by a raw record pointer
when C++ dispatch expects an abstract interface pointer. Property-only interfaces
now receive one generated Oilpan adapter that traces its record and forwards the
existing virtual getter/setter protocol. Callable interface members remain a
separate future step because the current dynamic `Value` deliberately does not
store type-erased functions.

Multi-file native compilation reuses `moduleGraph.ts`'s parser selection and
local-import resolution instead of teaching the CLI another extension/mapping
algorithm. Local ASTs are merged in dependency order and analyzed once, which is
important for C++ because independently emitted files would each contain a
runtime include and `main`. Import aliases are rejected explicitly for now:
blindly concatenating them would silently call the wrong global C++ symbol, while
correct support needs module-local symbol namespaces or binding-aware renaming.

Oilpan directly supports a `GarbageCollected<Base>` non-final class with ordinary
derived classes. This allowed native class inheritance to keep one managed object
identity: roots inherit `GarbageCollected`, derived classes inherit their base,
and each trace override delegates upward. Abstract methods map cleanly to pure
virtual methods, while analyzer-validated overrides and multiple interfaces map
to the same C++ virtual dispatch table used by existing interface calls.

The original async lowering queued an entire function body and implemented every
`await` with blocking `Task.get()`. Turning `Task` into a C++20 coroutine return
type removed both semantic mismatches: `initial_suspend` is `suspend_never`, so
code before the first await runs during the call, and settlement stores coroutine
continuations that the runtime resumes as microtasks. Top-level `.get()` remains
only as the native entrypoint bridge that drives the event loop.

C++ forbids `co_await` directly inside a catch handler. Promise recovery and
finally helpers therefore capture the exception or rooted result first, leave
the handler, and only then await continuation callbacks. This also makes the
Oilpan lifetime boundary explicit: pointer results use `TaskStorage` while a
finally callback is suspended rather than sitting as an untraced raw pointer in
the coroutine frame.

Expanding collection APIs reinforced that call classification belongs in one
place. Array higher-order methods must not pass callback lambdas through the
dynamic-value argument conversion used by `push` and membership queries; the
emitter now distinguishes value-taking operations from callback-taking ones
before routing both to the runtime. Managed strings continue to cross APIs as
`Value`, while split results become owned native strings in a typed vector.

Validating the standalone timer fixture after the exact-finally rewrite exposed
a distinction hidden by emitter-only tests: a non-async function declared to
return `Promise<T>` returns `Task<T>` directly, while an async function's coroutine
completion carries only `T`. The first return-signal boundary used the resolved
type for both cases, producing a C++ catch that attempted to return `T` from a
`Task<T>` function. Callable emission now derives the boundary completion type
from the same task-producing decision used by the signature. The focused emitter
test asserts the complete `Task<T>` signal type, and the timer fixture is also
compiled and executed as a native integration check.

Adding direct `cpp` and `executable` CLI commands reinforced that command behavior
and command presentation have separate lightweight entrypoints. The Commander
program owns execution and detailed help, while `cli-bin.ts` serves startup help
without loading the compiler graph; `runCli` also keeps a small known-command set
for file shorthand detection. A new command must update all three surfaces and
exercise both dispatch and help in tests. The implementations themselves reuse
the existing C++ emission and native-link functions, and `native` remains a thin
compatibility command instead of creating a second build path.

Running the new executable command from the fixture directory with the user's
contextual `map { it ... }.filter { it ... }` callbacks exposed two integration
gaps that emitter-only typed-arrow coverage had hidden. The native lambda helper
required explicit annotations even though semantic analysis had already accepted
implicit `it`; it now emits missing callback types as C++ `auto`, leaving generic
lambda instantiation to the typed collection helper. The initial error was also
attached to the enclosing function, which made its correctly annotated `number`
parameter look responsible. Once that was fixed, native compilation revealed
that console output lacked a `std::vector<T>` printer. The runtime now recursively
prints vector elements in brackets. The exact `../vexa executable timer.vx`
workflow compiles, links, and produces `after one second [6, 12]`.

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
- Interface pointers must remain Oilpan mixins when they cross a traced field,
  persistent callback capture, task, or coroutine boundary. A plain abstract C++
  base can pass dispatch tests while still being unsound under collection.
- Homogeneous arrays retain their typed-vector path. Heterogeneous and sparse
  arrays deliberately use `Value`, and future collection features must preserve
  that explicit dynamic representation instead of relying on C++ deduction or
  silent coercion.
- Packaged CLI releases must continue including both `native/runtime.cpp` and
  `native/oilpan-standalone-main.zip`.
