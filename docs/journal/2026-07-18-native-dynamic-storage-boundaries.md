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
