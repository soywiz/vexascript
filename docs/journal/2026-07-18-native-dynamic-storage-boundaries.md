# Native Dynamic Storage Boundaries And Nominal AST Experiment

## Context

The native self-host compiler could be emitted and linked, but its first run on
a minimal source exposed runtime failures that the generated C++ compiler did
not reveal at build time.

## Findings

* Optional calls on dynamic members must preserve call optionality separately
  from optional member access. Calling an absent `options.profile` callback
  showed that emitting `dynamicGet` followed by unconditional `call` loses the
  semantics of `profile?.(...)`.
* A `Value` used by `for-of` cannot be assumed to contain an array. Maps and sets
  need the same canonical dynamic iterable protocol so values retrieved through
  dynamic storage retain their language iteration behavior.
* Conservative dynamic comparisons are safer than choosing a static C++
  operator from a semantic type when the emitted storage type is still
  `vexa::Value`.

## Rejected Prototype-Only AST Experiment

Changing only the shared `Node` interface to a class while leaving concrete
nodes as anonymous objects and retrofitting their prototype in
`Parser.attachNodeBounds` was tested and reverted. It increased parsing from
about 266 ms to 407 ms and pre-emission work from about 9.1 seconds to 10.1
seconds on the 44-module native compiler benchmark. It also produced an
unrepresentable C++ shape: structural AST interfaces would need to extend a
garbage-collected class.

These measurements reject only that partial prototype retrofit. They are not
evidence against a fully nominal AST. Anonymous objects enriched with undeclared
properties remain difficult to map to efficient C++ storage.

## Full Nominal AST Direction

The durable migration converts every concrete AST variant into a real class
with declared fields, typed positional parameter properties, and a shared
metadata base. Parser and compiler transformation sites construct those classes
directly; source-bound attachment never changes an object's prototype. Every
constructor body is deliberately trivial: it only delegates to `super`, and
discriminators are never supplied by callers.

The discriminator is a numeric `const enum NodeKind`, so a concrete constructor
uses `super(NodeKind.ReturnStatement)` and a class narrows `kind` to its enum
member. This preserves discriminated-union narrowing while emitting integer
comparisons. A controlled three-roundtrip JavaScript self-host benchmark used
otherwise identical numeric and string `const enum` variants. The numeric
variant reduced median time from 5.484 seconds to 5.363 seconds, approximately
2.2 percent. The numeric form remains the canonical representation.

A second controlled experiment replaced all 1,300 production
`kind === NodeKind.X` and `kind !== NodeKind.X` checks across 81 files with
nominal `instanceof` checks. Making that comparison valid exposed two remaining
violations of the nominal model. Namespace import isolation changed a
`MemberExpression` into an `Identifier` by mutating its discriminator, while
lowering and declaration merging used object spread to produce objects that had
the right fields but no AST prototype. Namespace isolation now returns a newly
constructed `Identifier`, and lowering, temporary programs, merged namespaces,
and merged interfaces now construct real node classes. A lowering regression
walks the complete result and requires every reachable node to inherit from
`Node`.

After those fixes, both variants passed TypeScript checking and three
byte-stable self-host roundtrips. Ten interleaved runs measured a 4.911-second
median for numeric discriminators and a 4.909-second median for `instanceof`.
The one-sample-trimmed means were 4.922 and 4.979 seconds respectively, making
`instanceof` about 1.1 percent slower by that statistic. The difference is
within run-to-run noise, so there is no Node.js performance reason to replace
the numeric discriminator. The `const enum` remains canonical while nominal
classes remain available where class identity is semantically useful and for
future static C++ lowering.

Optional constructor parameter properties are real own properties initialized
to `undefined`; source metadata fields (`firstToken`, `lastToken`, and
`__vexaNativeSourcePath`) are also initialized on the shared `Node` base. This
gives native lowering a stable declared shape instead of relying on properties
being attached later. Reserved JavaScript property names were replaced by
explicit AST names such as `args`, `isDefault`, `isReadonly`, `isStatic`,
`isConst`, and `isAwait`, allowing the constructors to remain parameter-only.

The final full-suite pass found migration gaps that narrower AST searches had
missed. Two node-module and ambient-default-export paths still accessed the old
`default` field through anonymous structural casts, so default function imports
lost their callable type and declaration origin. They now use the declared
`ExportStatement.isDefault` field directly. A synthetic `BinaryExpression`
created solely to anchor an operator diagnostic also lost its source bounds
when its former initializer bag became positional constructor arguments; it now
copies the operator token into `firstToken` and `lastToken`. Finally, declaration
fixture tests that asserted string discriminator values now assert nominal class
instances. This is evidence that field-renaming migrations must search
compatibility-shaped casts as well as direct property access, and that every
synthetic diagnostic node must preserve explicit source metadata.

The follow-up optimization and Oilpan work remains recorded in
`docs/tasks/accelerate-native-self-host-iterations.md`.

## Regression Coverage

The single native language smoke now executes both absent and present optional
dynamic callbacks, iterates a dynamically stored map, and copies a map retrieved
through dynamic storage. Its output is checked for both JavaScript and native
execution. Parser coverage also walks a mixed program, verifies that every
reachable AST node inherits from `Node`, checks numeric discriminators, and
checks that shared metadata properties exist immediately after construction.
The JavaScript self-host test completes three byte-stable compiler roundtrips
with the nominal numeric AST. Native module execution covers namespace-member
rewriting, which now replaces the member node instead of changing its class in
place. Lowering coverage rejects prototype-losing structural copies.

## Optional Native Fields and Type-Only Redeclarations

The first full-compiler C++ emission attempt after the nominal AST migration
failed on `Node.firstToken?: Token`. Optional native fields cannot use the
underlying static C++ type because `undefined` is observably distinct from
null, zero, false, and an empty string. They now use `vexa::Value` storage.
Assignments convert into that representation, while a subsequent access such
as `node.firstToken.range` converts the stored value back to its declared
native class before accessing a statically known field. This keeps optional
object references alive and preserves the language's undefined semantics.

The next failure was a `declare kind: NodeKind.IntLiteral` discriminator
narrowing on a derived AST class. A declared class field is type-only and must
not allocate or initialize a second C++ field; the real `kind` storage already
lives in `Node`. Native class emission now excludes declared fields instead of
trying to map enum-member literal annotations as storage types.

The native language smoke covers absent and populated optional string and
managed-object fields, including an access through the populated object. After
these changes, the complete 44-module compiler emits a C++ translation unit
successfully. The profiled run took about 20.4 seconds: 0.35 seconds loading and
parsing, 3.44 seconds module-isolation analysis, 7.15 seconds merged analysis,
and 9.47 seconds C++ emission. Native C++ compilation and execution remain the
next milestone.

## First End-To-End Native Compiler Execution

The first successful native self-host execution compiled a minimal source into
C++, after which the ordinary native build pipeline linked and ran it with the
expected `hello from native compiler` output. The unoptimized native compiler
took 36.25 seconds to compile the minimal program. This establishes functional
execution; it is not a release-performance result.

The failures encountered on the path were reusable boundary problems rather
than compiler-specific exceptions:

* Optional chaining must propagate through the complete member chain. Emitting
  only the first nullable access made `range?.start.line` dereference a null
  `start`. Primitive results now retain `undefined` through `vexa::Value`.
* A captured managed pointer is stored in a `cppgc::Persistent`, so `??=` must
  recognize persistent handles as nullable storage. Pointer-only handling left
  captured arrays null.
* Contextual collection types must reach `new Set(...)` and related
  constructors. Converting a fully constructed `Set<Value>` into `Set<Node*>`
  is both inefficient and nominally invalid; construction now uses the expected
  element type directly.
* `Map.keys()`, `values()`, and `entries()` produce native arrays even when their
  declaration-level iterator type is abstract. Their emitted C++ result types
  must reflect the concrete runtime representation so `for-of` does not route
  them through dynamic iteration.
* Native module symbol isolation must preserve the source property name of an
  object-binding shorthand while renaming its local binding. Interfaces also
  need one enumerable view backed by their declared property getters.
* Node process state must root `argv` and `env`. Values needed after an `await`
  should also be copied into stable native values before suspension until the
  coroutine emitter traces every live managed local across suspension points.

Each language/runtime boundary above is covered in the single native language
smoke. The full 2278-test suite and the CLI validation passed after the native
compiler produced and executed the minimal program.

## Generated C++ Dispatch and String Representation

Generated callables no longer receive a `Runtime&` parameter solely to reach
the active heap. The runtime remains explicit at the application boundary and
is exposed to generated code through `Runtime::current()`. This removes a
pervasive parameter and avoids repeatedly rediscovering the same runtime while
retaining thread-local isolation between independent application threads.

String literals are deduplicated before emission. The generated translation
unit declares one static raw pointer per literal, initializes it once through
the application runtime, and keeps it alive with runtime-owned
`cppgc::Persistent` roots. Literal reads therefore neither allocate nor perform
a hash lookup. The roots are released only when the runtime and its heap are
destroyed.

Language strings now have one canonical `std::u16string` representation inside
`StringObject`. Equality, length, indexing, `charCodeAt`, and string-switch
dispatch operate directly on UTF-16 code units. UTF-8 conversion is reserved
for external boundaries such as console and file I/O. `std::wstring` was
rejected because `wchar_t` is 16 bits on Windows but 32 bits on macOS and Linux,
so it cannot provide portable JavaScript string semantics.

Dynamic class dispatch also receives UTF-16 property keys. Generated
`dynamicGet` and `dynamicSet` implementations first switch on code-unit length,
then on the first code unit, and only compare complete keys inside the matching
bucket. Each exact comparison is emitted on its own line. The same dispatch
builder is used for language string switches, avoiding two implementations
that could drift. Numeric dynamic array keys are parsed directly from UTF-16
without an intermediate UTF-8 allocation. Record fallback storage still uses
UTF-8 keys and converts only after declared dynamic dispatch misses; migrating
records to the same UTF-16 key representation remains a useful cleanup.

Native source-location hooks are now opt-in through
`--native-source-locations`. Removing them reduced the self-host translation
unit substantially, but an unoptimized build improved only modestly, so source
hooks were not the principal compiler bottleneck. Phase profiling showed that
the first module-isolation binding pass, which initializes and binds the
standard declarations, dominates minimal-program execution in the current
unoptimized native compiler. Future performance work should target declaration
initialization and generated semantic operations rather than relying on source
size alone.

The single native language smoke covers astral UTF-16 length and both surrogate
`charCodeAt` results, direct indexing after the surrogate pair, pooled literals,
dynamic reads and writes, and the existing language-wide edge cases. Source
locations have focused CLI coverage for both their default absence and their
explicit opt-in path.

The first self-host run after the UTF-16 migration exposed a second-order bug:
the parser stored source text as UTF-16, but `substring`, `slice`, `charAt`,
`indexOf`, and related runtime helpers converted to UTF-8 and then treated
UTF-16 offsets as byte offsets. The embedded declarations contain non-ASCII
documentation, so token slices became progressively displaced after those
characters. A focused native parser program reproduced 23 delimiter errors in
49.87 seconds while the source length still matched Node exactly. Moving the
positional string operations to UTF-16 code units removed every parse error.
The smoke now covers substring, slice, index lookup, positioned inclusion, and
`charAt` around a surrogate pair so the same boundary cannot regress silently.

The generated declaration constants also used an array containing every source
line followed by `join("\n")`. This made the native compiler allocate and join
thousands of strings on every cold runtime declaration load. The canonical
sources are now generated as two exact template-string blobs by
`scripts/generateEmbeddedRuntimeSources.ts`; a test checks byte-for-byte source
equality and rejects the former array representation. With the UTF-16 operation
fix and blob representation together, the same unoptimized native parser
reproduction fell from 49.87 seconds to 4.51 seconds.

## Conversion and Nominal AST Dispatch Boundaries

`convertValue` previously accepted a `Runtime&` even when a conversion only
copied a scalar, unwrapped a handle, or performed a checked native cast. This
made the runtime argument part of every generated conversion expression and
of every recursive template instantiation. The argument has been removed.
Only branches that allocate a string, collection, adapter, or callable now ask
`currentRuntime()` for the active heap at the point where it is required.

The same rule now applies to dynamic property helpers. A dynamic `Value` or
record still needs a free helper because its representation must be inspected,
but a known generated object pointer calls its virtual `dynamicGet` or
`dynamicSet` method directly. Generated free dynamic access no longer carries
a runtime argument. This keeps the generic boundary available without routing
nominal objects through it.

Several analysis APIs still described concrete AST nodes as structural
intersections such as `Node & { kind: NodeKind.JsxAttribute; name: string }`.
Those types prevented the native emitter from seeing the concrete class even
though the parser always constructs one. Replacing them with `JsxAttribute`
and `Identifier` made the generated `jsxAttributeNameRange` signature nominal
and changed its property read to the direct `attribute->firstToken`. This is a
useful migration pattern: make the TypeScript source tell the truth about a
known AST class, then let the existing static C++ path work instead of adding
an emitter special case.

After these changes the self-host translation unit contained 13,431
`convertValue` call sites but no call that propagated `Runtime`. It contained
no free `dynamicGet`, `dynamicSet`, or optional variant with a runtime argument.
Node emitted the 6.74 MB, 59,011-line unit in 20.02 seconds, and GCC compiled it
with `-O0 -DNDEBUG` in 16.96 seconds. The resulting native compiler generated a
hello-world translation unit in 9.11 seconds (8.42 seconds inside the profiled
pipeline); that C++ compiled in 1.83 seconds and printed the expected output.

The large conversion template remains a compile-time optimization candidate.
Splitting common scalar boxing and unboxing into small overloads, with templates
reserved for structural collection and callable conversions, may reduce both
template instantiation volume and optimizer work. That redesign was deliberately
deferred until the two-roundtrip bootstrap is functional so its value can be
measured rather than inferred from optimized-build latency alone.

## Native Emitter Bootstrap Regressions

The first native compiler that could emit the complete language smoke exposed
several cases where valid C++ generation depended accidentally on the richer
analysis metadata produced by the Node bootstrap. Optional collections,
captured nullish arrays, nested maps, Promise rejection arrays, and dynamically
assigned closures all lost enough metadata to fall through to invalid raw C++.
The durable fixes recover types from emitted local callable signatures, native
collection template arguments, explicit callable annotations, and contextual
array element types. The smoke now covers the optional collection and captured
array regressions alongside its existing dynamic callable, Promise, and nested
collection cases.

An attempted unconditional inference of `Map.get` from the analyzed map type
made the compiler translation unit invalid: an interface exposed
`Map<Value, Value>` in generated storage while analysis retained a more precise
array value type. Requiring the emitted receiver type to agree with the native
collection type prevents analysis from promising a representation the emitted
getter does not actually return. This is a useful boundary for later static
specialization: emitted storage is authoritative once lowering has erased a
source-level type.

The most important runtime discrepancy was string indexing inside compiler
helpers. JavaScript returns a one-code-unit string from `text[index]`, whereas
the initial dynamic C++ path produced a numeric code unit. Helpers that parsed
`std::function<...>` and nested C++ template arguments therefore compared a
number with strings such as `"<"`, `">"`, and `"("`; the parsers silently
returned no type and downstream emission became dynamic. Converting scanners
to `charAt` or numeric `charCodeAt` comparisons gives both runtimes explicit
UTF-16 semantics. The same cleanup was applied to shared TypeScript type-name
scanners so future native analysis does not depend on implicit index coercion.

After these fixes the `-O0 -DNDEBUG` native compiler emitted the complete smoke
in 22.26 seconds. The generated smoke translation unit compiled in 4.18 seconds
and its output exactly matched `expected.native.txt`. The failed branches above
were preserved because they explain why adding more inferred precision is not
always safe unless it agrees with the lowered C++ representation.

## Self-Host Scaling And Managed Weak Storage

The next complete self-host profile exposed three independent scaling and
correctness boundaries. Template-literal tokenization repeatedly sliced the
unconsumed suffix, making a large source quadratic under the UTF-16 native
runtime. Scanning by offsets and slicing each completed segment once reduced
the 44-module native parse phase from more than two minutes to about 58 seconds.
The C++ emitter also performed repeated linear class, interface, method, getter,
setter, and stored-property searches. Per-program lookup maps and caches reduced
Node's generation of the compiler translation unit from roughly 14 seconds to
3.5 seconds and reduced native emission of the complete language smoke to about
0.8 seconds.

An ASAN run found that storing `cppgc::WeakMember` directly inside a
`std::vector` is invalid. Vector growth relocates the weak slots after Oilpan has
registered their addresses, so a later collection writes through stale
off-heap addresses. Weak maps and sets now allocate stable, traced entry objects
on the Oilpan heap and keep only `cppgc::Member<Entry>` handles in their ordered
vectors. This preserves insertion order without moving registered weak slots.

Finally, the native bootstrap inferred mixed array literals more narrowly than
the Node bootstrap, producing declarations such as `ArrayObject<bool>*` for
`[1, "two", true]`. Array literal emission now validates contextual and inferred
element types against the literal syntax and falls back to `Value` storage when
they disagree. This is intentionally the dynamic-mode rule: static array
specialization is valid only when every element is representable by the chosen
storage type. The native compiler now emits the complete language smoke in
about 9.2 seconds; that C++ compiles and produces byte-for-byte expected output.
