# Native CLI first roundtrip

The first native self-hosting roundtrip now uses the ordinary `cli/cli.ts`
entrypoint and emits the next compiler translation unit in 171 seconds with an
unoptimized native executable. The generated file is about 6.6 MB. The same
change keeps the complete native language smoke and the JavaScript self-hosting
roundtrips green.

## Performance failure that looked like a compiler hang

Sampling the native process showed that `charCodeAt(Text)` was selecting the
legacy `std::string` overload through an implicit conversion. Every character
lookup converted the complete UTF-16 source to UTF-8 and back, making tokenizer
work effectively quadratic. A direct UTF-16 `Text` overload changed character
access back to O(1) and reduced parsing the complete compiler graph to seconds.

When a UTF-16 runtime type replaces an older string representation, every
primitive helper overload and every shared type trait must move together. The
same omission also excluded `Text` from dynamic array views even though the
obsolete `std::string` type remained accepted.

## Nullable conditional emission

The compiler used a nested `string | null` conditional to select a collection
helper name. Generated C++ mixed `Text` and `Value` branches, and C++ selected
the implicit `Value -> Text` conversion as the common conditional type. The
null branch therefore failed at runtime. Returning directly from the four
known collection cases removed both the ambiguous conditional and an allocation
of a temporary `Set` for every `instanceof` expression.

The durable emitter follow-up is to ensure conditional branches are explicitly
converted to the analyzed result type whenever their native representations
differ. Source-level simplification is still preferable in compiler hot paths.

## Entrypoint and test regressions

Moving Node-only behavior behind the CLI adapter initially made direct-execution
detection compare `argv[1]` with the adapter module instead of the CLI module.
Child CLI processes exited before starting. The Node adapter now recognizes the
source and bundled CLI entrypoint names, while the native adapter treats the
compiled program as direct execution.

The class-backed global VFS reference also briefly lost the established
unconfigured fallback when tests deleted `ref`. Keeping the statically declared
field while retaining `globalVfs.ref ?? unconfiguredVfs` preserves both native
shape information and the browser/compiler contract.

For native source diagnostics, emitting `VEXA_NATIVE_SOURCE` calls is only half
of the debug setup: the translation unit must also be compiled with
`VEXA_NATIVE_DEBUG`. Release builds intentionally keep the macro as a no-op.
