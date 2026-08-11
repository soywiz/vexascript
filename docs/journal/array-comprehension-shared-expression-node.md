# Array comprehensions need a shared expression node

Date: 2026-08-11

## Context

Array-comprehension support initially looked small enough to desugar in the
parser to an immediately invoked function containing an accumulator and an
ordinary `for` loop.

## Investigation that did not work

The parser-level IIFE shape produced runnable JavaScript, but it was not a
durable compiler representation:

- the formatter would see only the generated lambda and lose the original
  `[for (...)]` syntax;
- type inference started from an empty accumulator instead of directly from
  the comprehension result expression;
- a probe with a `for` declaration inside an arrow body reported the iterator
  as undefined, because function-like expression scopes are created during
  type checking while statement-loop scopes come from binding. Combining the
  two synthetic paths did not preserve the intended loop scope.

Adding more metadata and special cases to the generated IIFE would have spread
the feature across the parser, formatter, analyzer, and emitters without one
authoritative representation.

## Resolution

`ArrayComprehension` is a first-class expression node containing the iterator,
iterable, result expression, and `in`/`of` mode. Structural traversal exposes
those children to shared compiler and editor services. The type checker creates
one comprehension-local binding scope and derives the result as an array of the
body type. JavaScript and C++ emitters then reuse their established loop
semantics while the formatter retains the source syntax.

## Regression lesson

New expression syntax that carries bindings should not be hidden behind parser
desugaring unless binding, inferred types, formatting, LSP traversal, and every
backend all consume the same lowered representation. A small explicit AST node
is preferable when it is the only durable source of truth across those
surfaces.

The full suite also exposed that node-kind discriminators are embedded in
generated declaration ASTs. Inserting the new kind before `Program` made cached
DOM programs look like comprehensions and failed traversal with an undefined
child kind. New node kinds must be appended so all existing numeric values stay
stable; `isNodeKind` must then use the new final kind as its upper bound.

A follow-up range regression exposed another parallel-path risk: the first
comprehension emitter copied JavaScript's `in` semantics even though ordinary
VexaScript loops intentionally treat declaration-free `in` as value iteration
and emit JavaScript `of`. That made `[for (n in 0 ..< 10) n]` enumerate object
properties on the range representation and return an empty array. Expression
features that embed loop syntax must reuse the language's loop semantics, not
the target language's spelling; comprehension `in` and `of` now both iterate
values in the type checker and both emitters.

Mixed array elements reinforced the value of that explicit node. An embedded
comprehension can be represented as an implicit `SpreadExpression` around the
same `ArrayComprehension`, so array inference, JavaScript spread emission,
native `appendAll`, traversal, and lowering need no parallel comprehension
branches. Only the parser and formatter retain whether the spread token was
implicit. The parser must parse the comprehension body as an assignment
expression rather than a comma expression so the following comma remains the
surrounding array's separator.
