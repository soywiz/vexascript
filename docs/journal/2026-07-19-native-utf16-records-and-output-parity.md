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
