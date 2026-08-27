# Native ECMAScript runtime coverage

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: Unavailable (not exposed by runtime)

## Context

The native language smoke previously concentrated many unrelated ECMAScript checks in one file and treated a substantial part of the declared runtime as unsupported. That made it difficult to distinguish complete family coverage from one happy-path assertion. The work split the smoke into declaration-locked family modules and implemented the missing deterministic runtime surface, excluding workers and APIs that require a fundamentally dynamic object or callable representation.

## What worked

- A policy generated from the bundled `es2025.d.ts` now requires every declared member in each tracked family to have either an executable label or an explicit unsupported reason. This exposed omissions much more reliably than manually reviewing a long smoke file.
- One generic typed-array implementation parameterized by kind covered all twelve numeric and BigInt representations without parallel implementations drifting. Shared buffer-backed storage made `subarray`, `set`, byte offsets, element conversion, and DataView interoperability testable through the same path.
- DataView tests assert the raw bytes for omitted, `false`, and `true` endianness. A setter/getter round trip alone was insufficient because matching bugs in both directions could pass while storing the wrong layout.
- Loading runtime namespace declarations into the TypeChecker, including their nested declarations, fixed `Intl` constructor and result typing generically. Modern TypeScript declaration objects also use `new (` with whitespace, which required a parser regression fix.
- The compact `Intl` runtime remained dependency-free and English-only. It implements every declared method entry point while avoiding ICU, CLDR, operating-system locale databases, and generated data bundles.
- Returning a dedicated `IntlSegmentsObject` rather than an array preserved the `Segments.containing` API while still supporting iteration and `Array.from`.
- `Intl.Locale.maximize` and `minimize` return new locale objects. The smoke exposed both an accidental mutation and a separate C++ overload-resolution bug where an `IntlObject*` selected the boolean `toString` overload. A constrained `BaseObject` pointer overload now preserves dynamic string conversion for chained runtime-object results.

## Failed or incomplete approaches

- Initially, `String.normalize` only validated the form and returned the original string. An ASCII smoke assertion passed but provided no semantic evidence. It was replaced with composition, decomposition, compatibility, and default-form checks. The implementation remains deliberately compact and its Unicode-data limitation is documented.
- The first `Intl.Locale.maximize` implementation handled only the exact tag `en`. The smoke constructed `en-US`, correctly exposing that the region-bearing form also needs the likely `Latn` script.
- Qualifying every nested namespace type fixed `Intl` but regressed Zod's external `core` namespace constraints. Runtime namespaces and arbitrary package namespaces do not have interchangeable lookup rules. Qualification is now limited to the ambient `Intl` declarations that require it, and both the Zod sample and its bounded LSP regression run cover that boundary.
- The first `Intl` `resolvedOptions` lowering returned a C++ `RecordObject*` but the emitter used the semantic structural result type and generated direct field access. Explicit emitted-result typing was needed so subsequent property access uses record lookup.
- Running the entire native smoke while iterating entered the expensive self-host cases after the relevant sample failure had already occurred. Focused `--test-name-pattern` execution was much faster for runtime behavior; the complete native fixed point remains a final-state validation only.

## Durable lessons

- Runtime coverage should be locked against declarations, categorized by family, and executed. Counting labels without running them does not validate semantics.
- Binary-layout APIs need independent byte-level or externally observable assertions, not symmetric round trips.
- A supported API with identity behavior and a trivial input is often equivalent to no test. Use inputs that force the defining behavior.
- Native omissions should identify the architectural constraint: property-key layout, direct-field lowering, callable representation, GC observability, runtime compilation, or host isolation. A generic “not implemented” list is not sufficient for review or future design work.
