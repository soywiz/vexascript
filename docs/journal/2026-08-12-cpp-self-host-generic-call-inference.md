# C++ Self-Host Generic Call Inference

## Context

The isolated self-host runner first failed while compiling the JavaScript-hosted
C++ compiler. `findNode<T>` emitted a C++ template whose `T` only occurred in
the return type, while its predicate parameter had already been erased to
`std::function<bool(Node*)>`. The generated call therefore had no C++ argument
from which clang could infer `T`.

Fixing that compile failure exposed a later fixed-point failure in the same
runner. A generic helper receiving a callback with a nullable object result was
specialized as `Undefined`; when the callback returned its object branch, the
native compiler attempted an invalid `Value`-to-`undefined` conversion.

## Root causes and fixes

- Generic call inference only recognized direct callback result parameters and
  collection-shaped argument patterns. It did not understand TypeScript type
  predicates such as `(node): node is T`. The C++ emitter now extracts the
  asserted type from both the parameter and callback annotations and binds the
  shared type parameter through the existing template-binding path.
- A union predicate such as `JsxElement | JsxFragment` must not invent a new
  runtime representation. The existing declared-type mapper selects their
  common `Node*` base, so the call becomes `findNode<Node*>(...)`.
- Nullable object results passed through generic callbacks need the expected
  C++ pointer type while the call and callback are emitted. Pointer-valued call
  conversion now supplies that contextual type, and direct generic return
  parameters consume it before callback argument emission. This keeps
  `Map | undefined` represented as the nullable map pointer rather than
  specializing the helper as `Undefined`.
- The contextual conversion is deliberately single-pass. It emits the call
  under the expected type and then performs one native pointer conversion,
  avoiding re-entry into the general expected-expression helper.

## Investigation branches that did not work

- The first type-predicate extractor used `RegExp.exec` and optional access to a
  capture group. In the self-hosted C++ compiler that capture access became a
  dynamic `Value`, so `.trim()` failed in `toText(Value)`. LLDB stopped in
  `typePredicateTargetName` and proved that the new helper, rather than module
  loading, caused the apparent source-file diagnostic. Replacing the capture
  access with typed `trim`, `indexOf`, and `slice` operations kept the helper
  self-host compatible.
- Fixing only the original clang error was insufficient. The runner then
  reached the native compiler for the first time and exposed the nullable
  callback specialization failure. LLDB stopped in
  `TypeChecker.typeParameterConstraintMap` through
  `withTypeParametersResult<Undefined>`, identifying a shared emitter problem
  instead of a cache or file-loading problem.
- Routing pointer calls directly through `emitExpressionWithExpectedCppType`
  caused infinite recursion when the pre-context semantic type still differed
  from the expected pointer. Emitting once under the contextual type and then
  converting once removed the cycle.

## Lesson

Self-hosting failures must be validated through the complete fixed-point runner,
not only until the first generated translation unit compiles. Each repaired
stage can reveal a deeper representation error in the compiler produced by the
previous stage. For native generic calls, inference must combine declared
predicate information, analyzed argument types, and the expected result type;
otherwise C++ template deduction can either fail at compile time or select a
runtime-incompatible specialization.
