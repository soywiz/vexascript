# Native base object and expression narrowing

## Context

The native runtime represented strings, records, and ordinary dynamic objects as three separate alternatives inside `Value`. At the same time, only ordinary generated objects inherited the class that owned dynamically attached properties. This made the value representation and object contract diverge even though every JavaScript-visible reference is an object with the same basic identity and property behavior.

The compiler also narrowed identifiers for statement-level `if (value instanceof Type)` branches, but did not preserve that narrowing in the right operand of `&&` or the consequent of a conditional expression. The generated compiler therefore used `dynamicGet` for statically known fields such as `NamedType.name`.

## Changes

- Added `BaseObject`, the common Oilpan mixin for strings, records, arrays, collections, functions, built-in objects, and generated classes.
- Moved the lazily allocated dynamic property record to `BaseObject`.
- Collapsed all GC-managed alternatives in `Value` and `StoredValue` to one `BaseObject` pointer while retaining inline undefined, null, boolean, number, bigint storage.
- Kept cheap explicit object-kind discrimination for the frequent string and record paths.
- Made generated root classes inherit `BaseObject` and delegate unknown dynamic gets, sets, and key enumeration to it.
- Ensured every runtime object trace method traces the base dynamic-property edge.
- Extended native expression narrowing to `instanceof`/`is` checks in `&&` and conditional consequents, invalidating context-sensitive C++ type caches while the narrowed expression is emitted.

## Investigation notes

The first expression-narrowing implementation emitted a direct `static_cast` of the source identifier. That only worked for raw pointers; compiler values may be held by `cppgc::Member` or `vexa::Value`. Using the runtime conversion boundary for the narrowed source handles every storage form and still removes the dynamic property lookup. The conversion boundary is intentionally temporary: the next optimization replaces the monolithic `convertValue` template with named specialized conversions.

Computing a new common type for every conditional expression also proved incorrect. It changed unrelated inferred numeric and optional-pointer expressions into `Value`. The durable fix preserves the existing conditional result selection and only re-emits the narrowed consequent with fresh context-sensitive type caches.

## Measurements

On this machine, before conversion specialization:

- Node native C++ emission: 7.64 seconds including the CLI build wrapper.
- Generated translation unit: about 7.15 MB.
- Native `-O0` compiler build: 21.77 seconds for the Node-emitted source.
- Native `-O1` compiler build: 105.22 seconds for the Node-emitted source.
- Native `-O0` self-host emission: 86.47 seconds for roundtrip one and 86.79 seconds for roundtrip two.
- Native `-O1` self-host emission: 16.01 seconds.
- The two native roundtrip C++ files are byte-identical.

The unified object representation is therefore semantically stable but is not itself a speed improvement. Conversion specialization and removal of redundant conversions remain necessary before judging the final architecture.

## Regression guidance

Keep behavioral smoke coverage for statement, logical-expression, conditional-expression, and stable-member `instanceof` narrowing. A native self-host compile is required in addition to runtime output because a dynamic access can be behaviorally correct while still hiding a static field and inflating the generated code.
