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
with declared fields, a constructor, and a shared metadata base. Parser and
compiler transformation sites construct those classes directly; source-bound
attachment never changes an object's prototype. Concrete classes retain a
literal `kind` declaration so existing discriminated-union switches continue to
narrow while native code can later use class identity and `instanceof`.

Optional fields require special care. Native class declarations are useful for
static layout, but JavaScript own-property presence is observable. Optional AST
fields are therefore type-only declarations in JavaScript and constructors add
them only when the initializer contains them. This preserved JSX's distinction
between an absent intrinsic-tag `reference` and a component reference.

The follow-up optimization and Oilpan work remains recorded in
`docs/tasks/accelerate-native-self-host-iterations.md`.

## Regression Coverage

The single native language smoke now executes both absent and present optional
dynamic callbacks, iterates a dynamically stored map, and copies a map retrieved
through dynamic storage. Its output is checked for both JavaScript and native
execution. Parser coverage also walks a mixed program and verifies that every
reachable AST node inherits from `Node`.
