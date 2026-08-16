# C++ self-host dynamic collection boundaries

The isolated compiler self-hosting job first failed while clang compiled the
JavaScript-hosted compiler. New `TypeChecker` code used chained
`map`/`filter`/`every` operations over anonymous records and nullable
`AnalysisType` results. The TypeScript and JavaScript hosts preserved the
refinements, but C++ emission represented the anonymous record fields and
nullable callback results as `vexa::Value`. Clang then rejected those values
where `AnalysisType*` and `ArrayObject<AnalysisType*>*` were required.

The affected code now accumulates directly into explicitly typed
`AnalysisType[]` arrays. This keeps the same discriminated-union, schema-output,
and mapped-intersection behavior while giving every self-host stage one stable
native representation.

Fixing the clang errors exposed two later failures when the native compiler ran
for the first time. Both local module resolution and text-module resolution
indexed a `Readonly<Record<string, string>>` to test whether an import mapping
existed. JavaScript returns `undefined` for a missing key, but generated C++
used strict `recordGet<string>`, which attempted to convert the missing value to
a string. Both paths now test membership with `in` before reading the mapping.

The first text-module fix still used a conditional expression with a string
branch and an `undefined` branch. Although its inferred TypeScript type was
`string | undefined`, the generated C++ conditional selected `std::u16string`
as its common type and eagerly invoked the `Value`-to-string conversion for the
`undefined` branch. Replacing that conditional with explicit guarded control
flow removed the implicit native conversion.

LLDB was necessary because the command-line error only reported
`VexaScript value is not a string`. Breaking on invalid `toText(Value)` and
`Value::operator std::u16string()` calls first identified strict `recordGet`
inside `resolveLocalModulePath`, then the equivalent access inside
`resolveTextModuleSourcePath`, and finally the conditional-expression
conversion. The complete `pnpm self-host:ci` fixed-point run was essential:
stopping after the original translation unit compiled would have missed every
runtime failure.

When compiler code crosses dynamic collection boundaries, prefer explicit
membership checks and typed accumulation. Avoid relying on JavaScript missing
property semantics or mixed native/dynamic conditional expressions unless the
C++ representation is covered directly. Always validate self-host fixes through
both native generations and the final byte-for-byte fixed-point comparison.
