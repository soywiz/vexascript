# Native runtime UTF-16 boundaries

## Keep semantic strings in one representation

The native runtime accumulated narrow-string overloads around `RecordObject`,
property enumeration, URI helpers, paths, subprocesses, and process state. The
overloads made an apparently harmless property operation cross the UTF-16/UTF-8
boundary several times and allowed generated code to select different APIs
depending on incidental static types.

`runtime.cpp` now keeps semantic strings and object keys as `std::u16string`.
`RecordObject` has one UTF-16 API, enumerable keys remain UTF-16, and URI
encoding and decoding consume and return UTF-16. UTF-8 file, console, process,
environment, regular-expression, exception, and numeric-formatting boundaries
are isolated in `native/utf.h`. This is an explicit platform adapter, not a
second semantic string representation.

## Mechanical replacement exposed real boundaries

A broad `std::string` to `std::u16string` replacement was useful for inventory,
but did not produce valid C++ by itself. In particular, libc++ does not provide
the locale facets required for numeric insertion into
`std::basic_ostringstream<char16_t>`. Numeric and date formatting therefore
remain narrow only inside the boundary adapter and immediately convert their
result to UTF-16. BigInt's internal decimal parser has the same boundary.

The migration also exposed narrow label literals emitted for labeled `break`
and `continue`. The complete native language smoke caught these because it
compiles and runs one program containing the language edge cases; generating
text alone would not have found the invalid comparisons.

## Pooled literals need code-unit lengths

Pooled string literals now use `__VEXA_STRING_LITERAL`, which constructs a
`std::u16string` with an explicit `char16_t` code-unit length. The length is
`sizeof(str) / sizeof(char16_t) - 1`, not `sizeof(str) - 1`: the latter counts
bytes and would over-read every UTF-16 literal. The existing embedded-NUL smoke
case verifies that pooling preserves content after a zero code unit.

## Self-host regressions need compilation validation

The full CLI previously emitted a C++ file successfully while source patterns
such as inline import types still generated unsupported native forms. The CLI
regression now compiles the ordinary `cli/cli.ts` graph and runs a real
`-fsyntax-only` native compiler check. The validation shares the production
compiler frontend arguments so it cannot silently drift into a less realistic
test configuration.

## Static container knowledge must outrank dynamic storage fallbacks

A computed access such as `call.args[index]` was emitted through `dynamicGet`
when the intermediate member expression was conservatively classified as a
`Value`, even though semantic analysis and the native member type both knew it
was an array. That converted the numeric index to a UTF-16 property key and the
runtime parsed it back into an integer.

Managed-array computed access now takes the shared `arrayGet` path before the
dynamic-value fallback. On the complete CLI translation unit this reduced
`dynamicGet` occurrences from 2,013 to 1,809 and `propertyKey` occurrences from
389 to 129, while increasing direct `arrayGet` calls from 499 to 759. The
existing native smoke's callback array indexing exercises the same path.

Number and fixed-point formatting also no longer builds locale-aware streams.
The UTF boundary adapter uses bounded `std::to_chars` calls and widens the
ASCII result directly to UTF-16, avoiding an intermediate allocated UTF-8
string on these compiler hot paths.
