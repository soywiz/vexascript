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

## Follow-up: static primitive conversions

`convertValue<Result>` is also unnecessary when both source and destination are known native primitives. The emitter now returns identical boolean types directly and uses `static_cast` between native numeric types. It deliberately does not use a C++ cast for numeric-to-boolean conversion because JavaScript truthiness differs for values such as `NaN`.

This reduces `convertValue<double>` call sites in the generated compiler from 620 to 132 and `convertValue<bool>` from 428 to 277. Remaining numeric conversions consume dynamic `Value` or nullish-expression results and therefore still require checked unboxing.

## Regression guidance

Keep behavioral smoke coverage for statement, logical-expression, conditional-expression, and stable-member `instanceof` narrowing. A native self-host compile is required in addition to runtime output because a dynamic access can be behaviorally correct while still hiding a static field and inflating the generated code.

## Follow-up: focused instance conversion

Object unboxing no longer needs to instantiate the complete `convertValue<Result, Input>` decision tree. `Value::toInstance<T*>()` now owns null handling, checked object casts, structural-record adaptation, and weak-collection object validation. The free `toInstance<T*>(input)` boundary handles native pointer storage forms without collection-specific branches. The general converter delegates its pointer branch to that API, and the emitter uses it directly for dynamic native receivers and directly emitted `null`/`undefined` values.

An initial emitter implementation selected `toInstance` from the semantic expression type. That was too broad: contextually typed record access could emit a concrete pointer even when its source node retained a dynamic semantic type, producing an invalid member call on the pointer. The reliable condition is the type of the emitted C++ expression. Direct `Value` literals are handled explicitly, while dynamic receiver casts already pass through the dedicated native-pointer emission path.

The unified native language smoke includes a typed null class pointer so null unboxing remains covered by executed behavior.

## Follow-up: deferred object boundaries and focused conversions

The generated interface enumeration and class dynamic-property methods originally appeared inline before all referenced generated classes were complete. That ordering forced boxing through `convertValue<Value>` because C++ could not yet prove that a forward-declared pointer inherited `BaseObject`. Replacing that conversion directly with `toValue` failed at compilation; it was not a valid overload-resolution problem to hide behind another generic wrapper.

The durable fix keeps the declarations on their owning classes but emits the method bodies after all class definitions. At that point the regular `toValue` and `toInstance` overloads have complete types. Record-interface method adapters use the same deferred-body path. This also makes generated class declarations smaller and easier to inspect.

Concrete unboxing now uses focused functions for text, booleans, native numbers, bigint, null, undefined, errors, functions, and object pointers. Array, map, and set pointer conversion traits were deleted because the common `BaseObject` path already preserves identity and performs the required checked cast. The legacy `DynamicValueObject` alias was removed in favor of naming `BaseObject` directly.

The generated compiler translation unit is 6,911,479 bytes. It contains no concrete `convertValue<Result>` call sites: the remaining 36 sites are `convertValue<T>` inside genuinely generic compiler functions. Node semantic C++ emission takes about 6.3 seconds on this machine. Exact pre- and post-RTTI compile/link and native-generation measurements are recorded with the RTTI follow-up so all optimization levels use the same benchmark source.

Removing the old named Array/Map converter branches exposed one important distinction: the runtime collection classes are still templated typed views. An `Array<Value>` crossing an `any` boundary cannot be cast directly to `Array<string>`, and `Array<Derived*>` cannot be cast directly to `Array<Base*>`. The common replacement is a `DynamicObjectView` contract implemented by the collection itself. `toInstance` first attempts an exact object cast, then asks any compatible target view to wrap the same dynamic backing object. This preserves identity without putting Array/Map cases back into the conversion template. The native language smoke now executes both a dynamic-to-typed array view and a covariant object-array view.

The same self-host check found that converting `NativeShadowBinding` from an interface to a class was incomplete because one helper still constructed an anonymous object literal. Constructing `NativeShadowBinding` directly keeps the compiler on the static class path and avoids an invalid record-to-class conversion in generated C++.

## Experiment: standard RTTI and rollback

The custom `nativeTypeToken`, `dynamicTypeToken`, `dynamicCast`, and `nativeInterfaceCast` protocol duplicated the C++ object model in every runtime and generated class. Standard `dynamic_cast` handles ordinary downcasts, generated inheritance, cross-casts to compatible interfaces, and the generated `Error` mixin directly. Removing the protocol deletes generated methods and their inherited delegation branches rather than retaining two cast systems.

Oilpan's bundled CMake configuration explicitly disabled RTTI, so merely removing `-fno-rtti` from generated-program compilation caused a link failure for `typeinfo for cppgc::Platform`. The native cache now has an RTTI-specific key and removes that vendored target option asynchronously before configuring Oilpan. This keeps the static library and generated translation unit on one ABI configuration.

RTTI also forced complete `FunctionObject<Task<...>>` vtables to instantiate and exposed an invalid dynamic return conversion that the token protocol had left dormant. Dynamic invocation now waits for a task and returns its settled value, or `undefined` for `Task<void>`, instead of trying to construct a `Value` directly from the task object.

The full native language smoke and all 2,340 tests pass with RTTI. The generated compiler source falls from 6,911,468 to 6,818,809 bytes. Initial `-O0` measurements are neutral: compile/link changes from 24.08 to 24.06 seconds and native generation from 71.35 to 72.00 seconds. RTTI therefore simplifies the object model and generated source, but does not by itself improve unoptimized self-host execution.

### RTTI benchmark matrix

Every row uses the same semantic `cpp cli/cli.ts --target optimized` workload. Compile time includes linking against the matching Oilpan library. Generation time is the resulting native executable generating the compiler translation unit once.

| Cast model | Optimization | Compile + link | Executable bytes | Native generation |
| --- | ---: | ---: | ---: | ---: |
| Custom tags | `-O0` | 24.08 s | 39,273,376 | 71.35 s |
| Custom tags | `-O1` | 112.01 s | 18,679,936 | 14.30 s |
| Custom tags | `-O3` | 143.10 s | 18,587,840 | 13.53 s |
| RTTI | `-O0` | 24.06 s | 39,496,064 | 72.00 s |
| RTTI | `-O1` | 109.93 s | 19,134,288 | 14.87 s |
| RTTI | `-O3` | 141.59 s | 19,046,064 | 14.54 s |

Node generation takes 6.32 seconds before and 6.57 seconds after the RTTI emitter change. The small difference is within normal run-to-run noise; RTTI does not affect the Node execution path. All three native optimization levels produce byte-identical C++ output. Compiling the first native `-O0` output takes 23.98 seconds, and that second native compiler generates an identical second-round output in 71.33 seconds. Both executed native roundtrips therefore stay below the two-minute target.

Custom tags are consistently faster in these native-generation measurements: by 0.9% at `-O0`, 4.0% at `-O1`, and 7.5% at `-O3`. Runtime generation speed is the deciding factor for the distributed compiler, while compiling the compiler executable is a comparatively infrequent operation. The implementation therefore returned to custom tags and restored `-fno-rtti`. The unrelated task-result invocation fix exposed by the RTTI experiment remains in place.

The Node-emitted and native-emitted files still differ by 353 bytes in redundant nullish and pointer conversion choices. They compile and behave identically, but byte identity between Node and native emission remains separate follow-up work.

## Follow-up: typed string literal pool

The literal pool originally stored pointers to boxed `Value` instances, even though every pooled entry was known to be a string. Statically typed string expressions separately constructed temporary `std::u16string` values from the same literals. The pool now roots `StringObject` instances directly. Typed expressions use the pooled object's UTF-16 value, while dynamic boundaries construct a `Value` only when required.

For the semantic self-host workload, the generated translation unit falls from 6,911,468 to 6,393,705 bytes. Its `-O0` compile/link time falls from 24.08 to 23.15 seconds, and native generation falls from 71.35 to 69.48 seconds. The two executed native roundtrips take 69.48 and 69.49 seconds and produce byte-identical C++. Node and native output still differ by 416 bytes in the existing nullish and pointer-conversion choices.

## Follow-up: static optional-property comparisons

An `-O0` native sample taken during semantic analysis spent about 85% of the sampled window in the type checker. Its low-level stacks were dominated by `Value` copy/destruction and the `cppgc::Persistent<BaseObject>` alternative inside each dynamic value. Optional expressions such as `token?.type === TokenType.SYMBOL` amplified that cost by constructing an optional-result `Value`, boxing the enum, and calling `strictEquals` even though analysis already knew the receiver field and comparison type.

Safe optional comparisons with stable receivers and operands now emit a direct null check followed by a typed field comparison. This removes 1,523 `toValue` calls, 510 `strictEquals` calls, and 1,298 `Value` references from the self-hosted compiler. Generated size falls again from 6,393,705 to 6,306,470 bytes. The `-O0` build takes 23.18 seconds, and the two native generation runs take 66.89 and 62.22 seconds while producing byte-identical C++.

## Follow-up: control-flow smart casts

The emitter already shared positive `instanceof` narrowing between conditions and branch bodies, but it missed two equivalent TypeScript control-flow forms: the right side of `!(value instanceof Type) || value.property`, and statements following an exiting guard such as `if (!(value instanceof Type)) return`. Both forms fell back to `dynamicGet` despite the checked program proving the concrete class.

False-side narrowing now reuses the same type-state mechanism as positive narrowing. Guard narrowing is retained only when the guarded branch always exits according to the shared control-flow analysis and the identifier is not reassigned later in the block. Lambda capture also uses the narrowed pointer expression, avoiding a base-pointer capture with an incompatible derived `Persistent` type.

The complete compiler drops from 559 to 482 generated dynamic property reads. The remaining additions to the emitter make the Node-generated translation unit 6,318,259 bytes, but its `-O0` compile and link time falls from 23.18 to 19.41 seconds. The first native compiler generates C++ in 60.91 seconds; compiling that output takes 19.63 seconds, and the second native compiler completes in 60.57 seconds. The two native outputs are byte-identical and remain comfortably below the two-minute limit.
