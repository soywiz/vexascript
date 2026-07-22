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

## Follow-up: conjunction narrowing and native primitive comparisons

Extending the same narrowing source to conjunction-backed `if` bodies removed dynamic field access from conditions such as `value instanceof NamedType && values.length > 0`. The body now performs one checked cast and then uses static members, while zero-length array comparisons emit `empty()` directly.

An initial implementation classified an optional member by its declared property type. That was incorrect: `object?.stringProperty` is emitted as `Value` because it must also represent `undefined`. It consequently generated a native string comparison that tried to convert `undefined` to a string. The durable rule is that optional members and members below an optional chain are never direct native primitives, regardless of their declared property type.

The compiler also exposed an existing contextual-type leak in array literals: the expected array type remained active while emitting each element. Emitting every element under its own expected element type fixed a conditional expression that was incorrectly converted to an array pointer.

After these fixes:

- The Node-emitted translation unit is 7,113,046 bytes and contains 16,640 `convertValue` call sites, down from 7,156,554 bytes and 18,281 call sites.
- The native `-O0` compiler build takes 24.12 seconds.
- Native semantic self-host emission takes 69.99 seconds for roundtrip one and 70.93 seconds for roundtrip two, down from about 86.5 seconds.
- The two native roundtrip C++ files are byte-identical.
- Node and native emission still differ in redundant conversion choices around nullish expressions. Matching those outputs remains follow-up work.

## Follow-up: specialized value boxing

The dominant conversion was boxing a statically known C++ value into `vexa::Value`. Routing that operation through overloads named `toValue` avoids instantiating the two-dimensional `convertValue<Result, Input>` decision tree for every input type. The generic conversion remains available for unboxing, array conversion, checked pointer casts, and forward-declared adapter boundaries.

Two edge cases matter:

- Generated adapters can refer to forward-declared classes before C++ can prove that they inherit `BaseObject`. Those boundaries keep the generic conversion until declaration ordering is improved.
- A pointer without a matching pointer overload can implicitly select the boolean overload. A pointer catch-all is required so enumerable interfaces preserve object adaptation instead of becoming `true`.

With specialized boxing:

- The generated translation unit is 6,936,080 bytes.
- Total `convertValue` call sites fall from 16,640 to 6,793; `convertValue<Value>` falls from 10,876 to 1,029.
- The native `-O0` build improves from 24.12 seconds to 21.12 seconds.
- Native semantic self-host emission takes 67.52 seconds for roundtrip one and 73.12 seconds for roundtrip two.
- The two native roundtrip outputs remain byte-identical.

## Regression guidance

Keep behavioral smoke coverage for statement, logical-expression, conditional-expression, and stable-member `instanceof` narrowing. A native self-host compile is required in addition to runtime output because a dynamic access can be behaviorally correct while still hiding a static field and inflating the generated code.
