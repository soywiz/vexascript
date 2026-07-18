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

Optional constructor parameter properties are real own properties initialized
to `undefined`; source metadata fields (`firstToken`, `lastToken`, and
`__vexaNativeSourcePath`) are also initialized on the shared `Node` base. This
gives native lowering a stable declared shape instead of relying on properties
being attached later. Reserved JavaScript property names were replaced by
explicit AST names such as `args`, `isDefault`, `isReadonly`, `isStatic`,
`isConst`, and `isAwait`, allowing the constructors to remain parameter-only.

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
with the nominal numeric AST.
