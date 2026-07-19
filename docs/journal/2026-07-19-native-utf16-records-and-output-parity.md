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
