# Native `instanceof` self-host stability

Production AST equality checks were migrated from numeric `NodeKind` comparisons to concrete `instanceof` checks while retaining `switch` dispatch where it remains useful. This exposed stale unit-test fixtures that only imitated nodes with `{ kind }`; tests exercising class-based behavior must construct real AST classes so JavaScript and generated C++ validate the same object model.

The migration also exposed native emitter type loss around stable optional member paths. A shared `nodeStartOffset` helper keeps `firstToken.range.start.offset` statically typed, and explicit locals in a few hot compiler paths let the C++ emitter use direct fields rather than `dynamicGet`. The complete compiler output dropped from 1,426 to 900 `dynamicGet` calls and from 328 to 322 `dynamicSet` calls.

The first self-hosted C++ generation compiled, but the second generation initially failed. The native compiler had specialized several `string | null` nullish-coalescing chains as plain strings and emitted conversions of `null` or `undefined` to `std::u16string`. Replacing those long `??` expressions with explicit control flow fixed the runtime failures and made the first and second native C++ outputs byte-identical. LLDB breakpoints on the failing conversion were much faster and more reliable than guessing from the top-level diagnostic.

Checkpoint measurements on the same generated CLI translation unit:

- Node C++ emission: 6.19 seconds.
- Generated C++ size: 7,125,614 bytes.
- O0 compilation: 23.22 seconds.
- O0 native C++ emission: 82.89 seconds, then 82.52 seconds.
- O1 compilation: 102.93 seconds.
- O1 native C++ emission: 14.52 seconds.
- Generic `convertValue<...>` occurrences: 9,252.

O1 cuts native execution substantially but makes C++ compilation over four times slower than O0. The next optimization should reduce generated template instantiations by selecting named conversion functions directly, while retaining `vexa::Value` as the compact heterogeneous primitive/reference representation.
