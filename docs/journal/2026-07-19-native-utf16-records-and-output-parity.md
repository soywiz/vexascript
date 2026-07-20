# Native UTF-16 records and output parity

## UTF-16 record keys

`RecordObject` previously stored property names in `std::string`. Every dynamic
get, set, membership test, and deletion converted the runtime's canonical
UTF-16 `PropertyKey` to UTF-8 before accessing the record. The maps for visible
and hidden properties and the insertion-order vector now store
`std::u16string`. ASCII and UTF-8 overloads remain boundary adapters, while
dynamic operations stay UTF-16 end to end.

The complete native language smoke now writes, reads, enumerates, and checks
membership for the key `á😀`. This covers both a non-ASCII BMP code unit and a
surrogate pair without adding a second native test program.

## Nominal analysis types

The analysis type variants now share `AnalysisTypeBase` and use simple concrete
classes instead of anonymous object literals. Factory functions remain the one
construction API. Moving the `kind` guard before variant-specific access found
two real JavaScript assumptions: `LiteralType` and `FunctionType` were cast
before their discriminator was checked. JavaScript tolerated those assertions;
native checked casts correctly rejected them.

Enabling common-base pointers globally in the C++ emitter was attempted and
discarded for this checkpoint. It reduced generated `dynamicGet` calls from
3,258 to 2,263 and `convertValue` calls from 24,130 to 22,741, but exposed typed
array paths that still construct `Array<Value>` for map callbacks and spreads.
The nominal source model is retained, while C++ promotion must proceed by
covered families rather than making the full output uncompilable at once.

## Profiling results and rejected hypotheses

For the checked 44-module CLI graph, native `-O1` compilation took roughly 110
to 119 seconds and the resulting compiler emitted the next C++ file in 27 to
33 seconds. `-O3` took 146.72 seconds to compile and emitted in 27.45 seconds,
so it did not improve this workload. An unoptimized diagnostic build compiles
in about 22 to 28 seconds but takes more than three minutes to emit the compiler
after the nominal-type migration; it is only useful for failures reached early.

The compiler profile attributed about 9.3 seconds to merged type inference and
7.9 seconds to C++ emission in an earlier `-O1` build. GC marking, sweeping,
allocation, `Text` hashing, and UTF conversion appeared in sampling profiles.
A specialized UTF-16 `join` removed a full UTF-16 to UTF-8 to UTF-16 roundtrip,
but changed total emission by only about one percent. The hypothesis that the
final 7 MB string join dominated emission was therefore ruled out.

## Native versus Node output

The nominal checkpoint's native compiler successfully runs the ordinary
`cli/cli.ts cpp` command with semantic validation and emits the complete next
translation unit in 33.08 seconds. Its output is not yet byte-identical to the
Node-hosted output: 7,021,286 bytes versus 7,022,785 bytes, across 1,151 diff
hunks.

The first primary difference is contextual callback typing in
`LocalVfs.readDir`: Node emits an explicit `VfsDirEntry*` lambda result while
the native host emits an untyped lambda. The following string-pool indices then
shift by one, producing many secondary diffs. Future investigation should
compare semantic expression-map lookups and node identity across lowering
before changing string-pool ordering. Normalizing or sorting the pool would
hide the symptom without fixing the semantic divergence.

`AnalysisTypeKind` remains string-valued in this checkpoint. Once output parity
is restored, converting it to a numeric `const enum` should be benchmarked in
the same controlled way as `NodeKind`.

## Contextual arrays exposed coroutine rooting

Propagating an expected `Array<T>` through conversions fixed the first native
versus Node output difference: callbacks such as `entries.map(...)` now receive
the expected result element type even when the native semantic map is less
precise. It also changed several previously dynamic `Array<Value>` allocations
into their declared element types.

That change exposed a latent lifetime bug. Oilpan pointers stored as raw locals
inside a C++ coroutine were not rooted while the coroutine was suspended at
`co_await`. An optimized native compiler crashed while appending to an array
created before an await. Async and generator locals whose native type is a GC
pointer are now stored in `cppgc::Persistent`, and native property update
helpers normalize raw and persistent receivers through `vexa::rawPointer`.
The complete native language smoke keeps a typed array alive across an await.

The ordinary CLI spelling `executable --help` worked natively, while
`help executable` failed with a dynamic-call error. A nullish receiver expression
in `(command ?? root).exitWithHelp()` lost its nominal class receiver during C++
emission. Splitting it into explicit branches keeps both calls static and makes
the control flow simpler. The rebuilt native CLI now prints the command-specific
help and exits successfully for the exact `help executable` spelling.

Both hosts discovered the same 2,555 string literals but assigned indices in a
different order because generic AST child enumeration is host-dependent. The
pool now sorts the complete value set before assigning names. This reduced the
comparison from 1,113 index-cascaded diff hunks to 419 real code-generation
differences. The remaining first differences are concrete conversion and
static-versus-dynamic decisions, so further parity work can address causes
without reading through thousands of shifted literal references.

## Scoped callback results must cross the callback boundary

The native host incorrectly reported that `Array.push` and `Map.get` accepted
zero arguments. `collectInterfaceMembersInto` initialized a method type outside
`withTypeParameters`, then assigned the real signature inside its callback.
The generated C++ callback captured the outer local by value, so the assignment
never reached the caller. The same pattern also lost arrow- and function-
expression results inside nested async, sync, and generator scopes.

Scoped helpers now have separate void and result-returning forms. Callers that
need a value return it from the callback instead of relying on mutation of a
captured local. The migration covered interface overloads, constructors, type
aliases, class methods, generic constraints, and function expressions. A
checked collections fixture now produces byte-identical C++ under Node and the
native compiler, and the unified native smoke exercises both result-returning
and mutating callbacks.

This work exposed a second checked-cast failure in generic substitution. A
nullish fallback combined an arbitrary default `AnalysisType` with a
`NamedType`, causing emission to force the whole expression to `NamedType*`.
Making the common `AnalysisType` result explicit removed the invalid native
cast and allowed the full checked compiler graph to complete again.

## Embedded NUL literals require an explicit length

The native host represented `"\u0000"` as an empty string because generated
`Text(u"\0")` construction used the null-terminated pointer overload. Literal
emission now passes a UTF-16 `string_view` with its code-unit length, and pooled
UTF-8 initialization passes an explicit byte count. The smoke verifies that
`"a\u0000b"` has length three and preserves the code units after the NUL.

After these fixes and small source-side nominal typing improvements, the full
checked comparison fell from 419 real diff hunks to 45 context hunks. The
latest Node generation took 6.43 seconds, native `-O1` compilation took 112.70
seconds, and the native checked generation took 35.55 seconds. Exact output
parity and the second byte-identical native roundtrip remain pending.

## A generated file is not a successful roundtrip until C++ compiles

The first parity-reduction candidate generated successfully under both hosts
but was not valid C++. An explicit generic argument of `AnalysisType |
undefined` was emitted literally as a C++ template type, and a nullable
`Expr` constructor argument emitted `Value::null()` where the nominal C++
constructor required `Expr*`. Generation-only comparisons did not catch
either failure.

The scoped callbacks now infer the `AnalysisType` union result instead of
forcing a source alias into a C++ template argument. `NativePropertyMember`
became a nominal class whose receiver is always a real expression, with an
explicit `implicitReceiver` flag instead of a nullable receiver. This keeps
the constructor statically callable and avoids using null as an out-of-band
receiver marker.

After rebuilding from the Node-generated translation unit, two complete
native compiler generations completed in 31.26 and 31.37 seconds. Their
7,855,681-byte outputs were byte-identical with SHA-256
`db3241e7629da3c23891e458cd83f2f3e17b708c067e3f663364a1ee369488ff`.
The Node-hosted output still differs from the native fixed point in 19 context
hunks, concentrated in nullable array access, string-concatenation lowering,
project object construction, and one profiling callback. Exact cross-host
parity remains separate from the now-proven native-to-native fixed point.

## Cross-host parity needs explicit host-neutral boundaries

The final 19 Node-versus-native differences were not string-pool noise. They
came from contextual typing that one host preserved more precisely than the
other: optional generic arrays, inline profiling callbacks, nullable record
fields, inferred string operations, and process exit codes. Moving those
values through explicit nominal or primitive boundaries removed the divergent
emission decisions without adding a second compiler path.

A broad attempt to treat every locally typed identifier or string-method call
as directly emitted briefly expanded the comparison to hundreds of differences.
The optimization was unsafe because the two hosts did not yet agree on every
local semantic type. The successful approach stayed narrow: preserve concrete
types in source, remove optional object-literal ambiguity, and use explicit
primitive operations only at the affected boundaries.

The first byte-identical candidate still failed native compilation because a
nullable `Text` temporary was emitted as `Value`. Replacing it with a non-null
string accumulator fixed the generated C++ and reinforced the rule that parity
alone is insufficient: the shared output must compile and execute.

The Node host, the previous native compiler, and the rebuilt native compiler
now emit the same 7,854,905-byte translation unit with SHA-256
`26ce7a192ed2121dd478aaaa1e1ddb642df860af7255dd5a76b2001486b87a56`.
The `-O1` rebuild took 112.50 seconds and the rebuilt compiler emitted the next
roundtrip in 31.55 seconds, both within the two-minute acceptance limit.

## Coroutine parameters need roots independently of coroutine locals

Enabling `VEXA_PROFILE_COMPILER=1` made the optimized native compiler crash in
`resolveImportTargetFilePath`, while the same binary completed normally under
LLDB. The generated coroutine accepted `ModuleResolutionOptions*` as a raw
parameter, suspended at an await, and later dereferenced it. Existing coroutine
rooting covered locals and method receivers but not pointer parameters, so GC
could reclaim the options object while the coroutine was suspended. Profiling
changed allocation timing enough to expose the latent lifetime error.

Async functions, async lambdas, and generators now use one shared coroutine
block emitter. Every pointer-valued callable parameter receives a local
`cppgc::Persistent` root for the lifetime of the coroutine frame, and instance
methods continue to root their receiver. The unified native language smoke
passes a freshly allocated object into an async function, awaits a timer, and
reads the object afterward. The previously crashing native profile now
completes in 26.99 seconds.

An AddressSanitizer/UndefinedBehaviorSanitizer build also found two independent
host assumptions before the coroutine fix. `readJsonFile` inferred its
timestamp accumulator as an integer from `-1`, although filesystem timestamps
are large floating-point numbers. `TypeChecker.isCallableMatch` indexed an
empty parameter array with `length - 1`. An explicit `number` annotation and
`Array.at(-1)` respectively preserve JavaScript behavior without invalid C++
conversions or unsigned array indices.

The corrected Node host and two consecutively rebuilt native hosts emit the
same translation unit with SHA-256
`297d887a91a3b5582d75c834d36447a9aad8bf4e47586dc490d716d0b8cc8723`.
The two `-O1` rebuilds took 111.37 and 111.16 seconds, and the second native
compiler emitted the following checked roundtrip in 31.53 seconds.

## Sampling exposed exception-based normal returns

A 15-second native sample of the semantic-analysis phase showed roughly ten
percent of its stacks in `ReturnSignal`, `throwReturn`, and C++ unwinding. The
type checker used small stack-scope helpers whose `try` blocks returned callback
results and whose `finally` blocks restored state. The native emitter correctly
preserved `finally` by lowering those returns to exceptions, but that made an
ordinary expression callback pay for a throw and catch at every invocation.

The void and result-bearing function-context helpers are now separate, and
result helpers assign the callback result before the `finally` and return after
state restoration. `withTypeParametersResult` follows the same shape. This
keeps JavaScript cleanup semantics, avoids invalid `T = void` locals in C++, and
removes exception-based normal completion from these hot type-checker helpers.

The optimized compiler remained byte-stable across Node and native hosts. In a
profiled `-O1` run, merged type inference fell from 13.98 to 13.54 seconds and
total checked C++ generation fell from 26.99 to 26.32 seconds. Native C++ build
time was unchanged at 113.53 seconds. A follow-up sample identified the same
source pattern in emitter helpers, especially `withCallableContext` and
`withCppTypeParameters`, as the next normal-return exception hot path.

The emitter cleanup then made `withCallableContext` and
`withCppTypeParameters` concrete string helpers instead of generic functions,
returned their callback results after cleanup, and applied the same pattern to
the remaining state-restoring expression helpers. Generated references to
`ReturnSignal` and `throwReturn` fell from 127 to 97. Two profiled runs after
the emitter changes took 26.02 and 26.21 seconds; the best C++ emission phase
fell from 7.59 to 7.43 seconds. The generated translation unit still compiled
at `-O1` and remained byte-identical between Node and native hosts with SHA-256
`84d913582cc2fa1d190e4d41e51e8fbb1c9f3aceda4e09069831f962e29a06dd`.

## Reflective AST traversal hid a large dynamic hot path

After the exception-return cleanup, sampling still showed frequent UTF-8 to
UTF-16 conversion, object-key enumeration, hash lookup, allocation, and Oilpan
marking under `childNodes`. The traversal iterated every enumerable property of
each AST node, converted property names into native text, dynamically fetched
their values, and repeated the same reflective loop independently in
`walkAst`. This was especially expensive because semantic analysis traverses
the compiler's nominal AST repeatedly.

`childNodes` now has one centralized `NodeKind` switch covering every concrete
AST node and reads its typed child fields directly. Statement cases include
their annotations explicitly, leaf kinds are explicit, and an unknown future
kind fails immediately. `walkAst` reuses `childNodes`, removing the duplicate
traversal semantics. Constructors remain field-only nominal constructors; the
optimization does not add dynamic metadata or a parallel native-only AST path.

An initial exhaustiveness idiom assigned `node.kind` to a TypeScript `never`
local in the default branch. The native emitter represented that unreachable
local as C++ `void`, producing invalid code. Replacing it with an explicit
unsupported-kind error retained fail-fast behavior and restored valid C++.
This is a useful boundary: TypeScript compile-time-only `never` assertions
must not become runtime locals in generated native code.

A repeated full-suite run then found a stale persisted declaration AST whose
root still used the pre-migration string discriminator `"Program"`. The
runtime-program cache version had not changed when `NodeKind` became numeric,
so an old process-local cache file could be accepted after PID reuse. The cache
format is now version 3, and its tests build nominal nodes before serialization.
Because JSON persistence deliberately restores structural records without
prototypes, statement annotation traversal is keyed by the numeric kind rather
than `instanceof`; a regression test walks annotations after a serialize/parse
roundtrip.

The first profiled `-O1` native candidate fell from 26.02–26.21 seconds to
21.20 seconds. One intermediate repeat experienced longer GC pauses and took
33.30 seconds, which initially obscured the steady-state improvement. After
the cache-format regression was fixed, the two final native hosts completed in
20.80 and 21.68 profiled seconds. The best merged type-inference and C++
emission phases were 11.05 and 5.46 seconds. Their 7,907,570-byte translation
units compiled in 113.07 and 113.75 seconds, so the extra static dispatch code
did not improve or materially worsen C++ build time. Node and both native hosts
emitted byte-identical C++ with SHA-256
`09442947f87ee1c2a41a2ada5644e49ac758e36d8092f27c4d9f964fca57ef2c`.

## Hot emitter carriers must be nominal at every construction site

The next native sample showed `MemberParts` property reads under
`RecordObject::get`, UTF-8 to UTF-16 key conversion, and record-adapter methods.
Although the carrier had a fixed three-field interface, its constructors used
anonymous object literals, so native emission could not use direct class-field
access. The same sample showed `cppTypeForDeclaredName` allocating an empty
alias `Set` before every declared-type cache lookup and constructing utility
type-name sets on every cache miss.

`MemberParts` is now a nominal class with a positional constructor, and every
creation site uses that constructor. The declared-type helper creates an alias
set only on a cache miss, while utility-type classification uses string
switches instead of newly allocated sets. The generated translation unit lost
about 6 KB and no longer contains a record adapter for `MemberParts`.

The first native roundtrip exposed one missed anonymous construction site:
Node emitted it structurally, but the native host correctly rejected converting
the resulting `RecordObject` to `MemberParts*`. Routing that branch through the
shared constructor restored native execution and exact output parity. This is
why each nominal migration must be exercised by the native host rather than
accepted after Node-only generation.

Two stable profiled generations took 20.50 and 20.52 seconds, with C++ emission
at 5.18 and 5.25 seconds. The two `-O1` builds took 117.66 and 110.52 seconds.
Node and both native hosts emitted the same 7,901,507-byte translation unit with
SHA-256 `9754082e94d08c062ac8e14ced6e7fc9d8505f7648273b009267f345ad93953f`.

## Character-class regexes can hide inside manual scanners

The next sample attributed native time to `std::basic_regex` below
`substituteTypeNameText`. The function already used a manual scanner, but each
whitespace, identifier-start, and identifier-part decision still called a
regular-expression test. Native lowering therefore constructed and executed
regex machinery for individual UTF-16 code units.

Dedicated code-unit predicates now preserve JavaScript whitespace coverage and
the existing ASCII TypeScript-identifier rules without regex allocation. The
regression test includes non-breaking whitespace, labels, qualified names,
quoted type literals, and `$`/`_` identifiers. The adjacent declared-type cache
lookup now uses one `get` and avoids constructing a composite key when no C++
type parameters are active.

Node and both consecutively rebuilt native hosts emitted the same 7,903,101-byte
translation unit with SHA-256
`53026a27d1d0a931863cf639405be9498098951667217e0792e162ac0b2ec475`.
The native compiler phases took 20.66 and 19.81 seconds. The change removed the
sampled regex path but did not materially move total runtime, confirming that
allocation, Oilpan collection, and `Text` hash lookup are the next larger
targets rather than regex substitution itself.

## Nullable internal strings forced GC boxing in the hottest emitter cache

Changing the declared-type cache from `Map<string, string | null>` to a typed
map did not initially remove its allocation cost. The nullable result made
`cppTypeForDeclaredName` return `vexa::Value`, so every successful cache hit
still boxed its `Text` as a newly managed `StringObject` before callers
unboxed it again.

An empty string is not a valid C++ type name, so the emitter now uses it as its
private unmappable-type sentinel. The cache stores a nominal
`DeclaredCppTypeCacheEntry`, and `cppTypeForDeclaredName` returns `string`
directly. A small shared fallback helper keeps sentinel interpretation in one
place. Related emitter locals normalize absent declared types to the same
sentinel, avoiding host-dependent `string | null` inference and preserving a
single static representation through hot paths.

The first native attempt was faster but exposed 14 Node/native output hunks.
Those differences came from conditional and nullish expressions whose
contextual type was more precise in the rebuilt native host. Normalizing the
remaining boundaries to explicit strings removed all 14 differences rather
than accepting semantically plausible but non-identical output.

The final two `-O1` native hosts compiled in 104.00 and 102.56 seconds and
generated checked C++ in 18.88 and 18.81 seconds. Node and both native hosts
emitted the same 7,904,273-byte translation unit with SHA-256
`a1e03b4e923ddc7a180d8f0a1b3e6af0b4234c30485c121da8168d2043267d17`.

## Stable nominal cache values remove hidden record cloning

Sampling the next run showed `parseTypeNameShape` allocating a fresh managed
record even on cache hits. The cache stored structural values and deliberately
returned object-spread copies, including a copied type-argument array. Parsed
type-name and conditional-type results are now immutable nominal classes, so a
cache hit returns the same typed pointer. Separate typed cache helpers avoid
forcing unrelated map value types through `any`; negative conditional parses
use a dedicated string set because nullable class values still expose an
unsupported null-to-pointer lowering in generated C++.

The first native execution failed before analysis with `Object spread requires
an enumerable object`. LLDB localized the throw to project compiler-options
merging. The runtime already had record-spread overloads for both records and
dynamic class objects, but its `Value` overload delegated only records. It now
also delegates boxed dynamic objects. The unified native language smoke covers
spreading a class after it has flowed through `any`/`object`, preventing this
representation-dependent regression.

The two rebuilt `-O1` native hosts generated checked C++ in 19.02 and 18.97
seconds. The flat result relative to 18.88 and 18.81 seconds shows that the
removed cache allocation is not presently a dominant end-to-end cost. The
builds took 134.78 and 110.40 seconds, again demonstrating optimizer-time
variance. Node and both native hosts emitted byte-identical 7,898,962-byte
translation units with SHA-256
`3e26aa001fb18b0749d78847fadb1584ef9e7d6f6d0a676f488e805cc5535a5e`.

## Context callbacks obscured the hottest class-analysis path

A 15-second sample of the rebuilt host attributed 3,954 of 11,177 active
samples to checking methods of the compiler's `TypeChecker` class. Every method
body sat below four nested callback guards for generator, sync, async-like, and
type-parameter state. Those guards preserved the right stack discipline, but
native lowering turned each level into a captured `std::function` and made the
generated method difficult for both a reader and the C++ optimizer.

Function and class-method statement analysis now use shared begin/end context
operations with one direct `try/finally`. The shared operations remain the
single source of truth for stack ordering; only the callback allocation and
nested generated lambdas were removed. Result-producing expression paths keep
their existing helpers until profiling shows that they matter. Generated C++
capture warnings fell from 15 to 7, and the translation unit shrank by 1,577
bytes.

The first and rebuilt `-O1` hosts compiled in 104.22 and 109.16 seconds and
generated checked C++ in 18.63 and 18.66 seconds. Node and both native hosts
emitted byte-identical 7,897,385-byte translation units with SHA-256
`69080e315436126ef199b0247bafd8c8c3f76938d471370dfc9591110860380d`.
