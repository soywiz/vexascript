# TypeScript semantic validation during self-hosting

## Problem

The JavaScript and C++ compiler bootstrap commands only succeeded with
`--transpile-only`. Enabling VexaScript type diagnostics for the TypeScript
compiler source produced thousands of false positives, mostly around advanced
TypeScript generics, control-flow narrowing, ambient Node.js declarations, and
the large emitter implementations.

The native module graph and the JavaScript module graph also lost the parser's
source-language mode when reusing parsed artifacts. That caused `.ts` files to
be analyzed with VexaScript-only rules such as mandatory `override`.

## Resolution

Parsed artifacts now retain their source language, and `compileParsedSource`
forwards it automatically. This removes a duplicated, easy-to-forget language
decision from every graph consumer.

CLI compilation uses the TypeScript compiler as the semantic authority for
`.ts` and `.tsx` projects. Once `tsc --noEmit` succeeds, VexaScript still runs
binding, inference, lowering, and emission, but does not report its incomplete
TypeScript compatibility diagnostics. `.vx` sources continue to use the full
VexaScript semantic checker. `--transpile-only` remains the explicit way to
skip semantic validation.

The JavaScript self-host test no longer passes `--transpile-only` at any
roundtrip and remains byte-stable after three generations.

The native CLI now exposes asynchronous captured child-process execution. The
blocking process wait runs on a background future while the native event loop
polls completion, so compiler code does not introduce synchronous I/O. The
native `cliShared` adapter uses this primitive to run the same `tsc --noEmit`
validation as the Node adapter before emitting JavaScript or C++.

## Investigation notes

An initial diagnostic count appeared to implicate `cppEmitter.ts` almost
exclusively, but that measurement omitted the project's `baseUrl` and therefore
misclassified internal `compiler/...` imports as unresolved packages. Repeating
the measurement with the real project configuration exposed the broader
TypeScript-compatibility gap. Attempting to silence or individually patch those
diagnostics would have weakened semantic correctness and created a long series
of source-level workarounds.

The full native smoke also caught an independent regression: optional native
collection calls were emitted as boxed `Value`s, but their emitted type was
incorrectly recorded as `bool`. As a result, `optionalCall(...) ?? false`
dropped the coalescing fallback. Optional member calls now consistently report
their boxed emitted type.

The child-process bridge was first attempted with a class-typed options object.
That made ordinary object-literal call sites fail in generated C++ because the
record was not adapted to the generated class pointer. Keeping adapter options
dynamic matches the Node boundary and confines the dynamic access to the
platform shim. The runtime also copies command arguments before starting the
background operation; retaining an Oilpan array pointer in the worker would
cross the collector boundary and be unsafe.

The first checked native generation succeeded but its generated C++ exposed a
second-generation inference failure in a platform-only diagnostic expression:
`[stdout.trim(), stderr.trim()].filter(...).join(...)` became `Array<void>`.
The adapter does not need collection combinators to select command output, so
it now uses a direct conditional between stdout and stderr. This both avoids
the unsupported inference path and emits substantially simpler native code.

The next native generation then failed in `TypeChecker.resolveKnownMemberType`.
The access itself was only the symptom: dynamically dispatched `some`, `map`,
and `filter` calls had emitted their concise callbacks as `void`, so the mapped
type array contained `undefined`. Explicit `AnalysisType` parameter and return
annotations on these recursive member-resolution chains preserve their static
contract in the generated compiler and prevent invalid values from entering
the type model.

After that local fix, LLDB showed the invalid member was created upstream by
`resolveConstrainedNamedExpressionType`: its recursive `union.types.map(...)`
callback had likewise lost its return type and constructed a union containing
`undefined`. Giving that callback an explicit `AnalysisType` contract fixes the
producer instead of merely adding a null guard at the eventual property read.

A subsequent trace proved that other dynamic callbacks could still feed a
missing value into a union before constrained resolution ran. `unionType` is
now the durable invariant boundary: any missing runtime member becomes
`UNKNOWN_TYPE`, preserving conservative analysis and preventing malformed type
objects from escaping into later phases. A focused factory test covers this
normalization independently of the expensive native bootstrap.

Once unions were valid, the next LLDB trace reached
`computedMemberIndexArgumentTypes`. Its callback maps `Expr[]` to
`AnalysisType[]`, but the generated compiler had copied the input `Expr*` as
the callback return type and tried to cast `UNKNOWN_TYPE` to an AST node. An
explicit `(argument: Expr): AnalysisType` annotation records the intended
cross-domain mapping and removes that invalid native cast.

The following run reached the recursive `isSameType` pair cache with an absent
analysis type. Casting a possibly invalid value to `object` only satisfies
TypeScript; it remains an illegal `WeakMap` key at runtime. `isSameType` now
rejects missing operands conservatively before touching its cycle-detection
cache, with a focused regression test for both operand positions.

The next invalid value surfaced in `expandTypeAliases`: both recursive
`typeArguments.map(...)` callbacks had been emitted as `void`. Their return
types are now explicitly `AnalysisType`, and the deep alias normalizer treats
an absent input as `UNKNOWN_TYPE`. This keeps malformed dynamic values from
propagating while retaining conservative compiler semantics.

The next roundtrip reached `new WeakSet<object>()` in the AST traversal helper.
The constructed `WeakSet<T>` return type passes through
`substituteTypeParameters`, whose concise recursive `map` callbacks had lost
their return type in generated C++. The resulting `WeakSet<undefined>` failed
only when the symbol display type was rendered. Explicit `AnalysisType`
contracts now cover named type arguments, union and intersection members, and
tuple elements at this shared substitution boundary. A focused analysis test
keeps explicit constructed generic arguments intact.

The compiler then reached a typed set spread used while entering a native
lambda: `[...activeLocalNames, ...parameters.names]`. `appendAll` only accepted
typed arrays and treated every other value as a dynamic array, even though
JavaScript spread accepts general iterables. Typed sets now have a direct
conversion-aware overload, while the dynamic fallback uses the shared
iteration protocol. The complete native language smoke covers spreading an
existing `Set<string>` into a statically typed `string[]`.

Late in the second native generation, `emitNativeCollectionConstruction`
inferred C++ template arguments for a `Map`. Its `AnalysisType[]` to `string[]`
mapping callback lacked an explicit return contract, so generated C++ created
an `Array<Value>` and later rejected it as an `Array<Text>`. The shared map
construction path now declares the callback as `AnalysisType -> string`,
preserving the statically typed collection through self-hosted emission. The
conditional expression itself also widened its empty fallback to
`Array<Value>` despite that callback contract, so the inference now uses an
explicitly initialized `string[]` followed by a simple guarded assignment.

The second emitted C++ file then exposed a self-host stability difference in
the JavaScript emitter. Node inferred `T = string` for every call to
`withVariableDelegateShadows<T>`, while the first native compiler omitted that
inferred template argument in its output. C++ cannot deduce `T` through a
`std::function<T()>` conversion from a lambda. The six text-emission call sites
now state `withVariableDelegateShadows<string>` explicitly, making the source
contract independent of emitter-side generic inference.

Finally, the second-generation CLI reached `formatSemanticIssue`, where a
generated `SourceRange` class is structurally compatible with the private
`SourceRangeStart` interface but does not inherit it nominally. Structural
interface adaptation now wraps dynamic native objects in a live `RecordObject`
view: reads, writes, deletion, key enumeration, and GC tracing delegate to the
original object. This avoids a stale snapshot and preserves JavaScript/TypeScript
structural identity. The complete multi-file native smoke verifies that an
imported class can be viewed through a locally declared compatible interface
and mutated through that interface.

Nested structural properties use the generic `Value -> RecordAdaptable`
conversion rather than `adaptInterface` directly. That boundary now applies
the same live dynamic-object view after an exact native cast fails, so nested
shapes such as `SourceRange.start` retain structural behavior too.

## Stable two-roundtrip result

The final clean checked run used the ordinary `cli/cli.ts` entrypoint throughout
and never enabled `--transpile-only`:

- the bootstrap native CLI emitted roundtrip 1 in 232.00 seconds wall time
  (194.78 seconds user CPU),
- roundtrip 1 compiled with `-O0 -DNDEBUG`,
- the roundtrip-1 CLI emitted roundtrip 2 in 190.23 seconds,
- roundtrip 2 compiled with `-O0 -DNDEBUG`, and
- the roundtrip-2 CLI emitted `testFixtures/native-ladder-minimal.vx` in 2.77
  seconds; that C++ compiled and exited successfully.

The same roundtrip-2 CLI rejects `const value: string = 1` through the normal
TypeScript semantic check. The more feature-heavy `testFixtures/sample.vx`
still produces incorrect native-self-host diagnostics around generic standard
library calls, extension types, and operator resolution. That remaining
semantic fidelity work is separate from the now-complete two-roundtrip and
minimal-program bootstrap, and should be addressed before treating the native
compiler as a drop-in replacement for the Node compiler on complex projects.

The native smoke covers successful command capture in the existing complete
behavioral program. A manually compiled native CLI also rejects an invalid
TypeScript assignment through `tsc` and completes its first checked C++
self-host generation without `--transpile-only`.
