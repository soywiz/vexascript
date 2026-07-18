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

## Nominal AST Experiment

Changing only the shared `Node` interface to a class and attaching its prototype
in `Parser.attachNodeBounds` was tested and reverted. It increased parsing from
about 266 ms to 407 ms and pre-emission work from about 9.1 seconds to 10.1
seconds on the 44-module native compiler benchmark. It also produced an
unrepresentable C++ shape: structural AST interfaces would need to extend a
garbage-collected class.

A useful nominal AST migration must therefore convert concrete node variants to
typed classes and design their Oilpan inheritance and allocation as one change.
A prototype compatibility layer is both slower and architecturally incomplete.
The follow-up is recorded in
`docs/tasks/accelerate-native-self-host-iterations.md`.

## Regression Coverage

The single native language smoke now executes both absent and present optional
dynamic callbacks and iterates a dynamically stored map. Its output is checked
for both JavaScript and native execution.
