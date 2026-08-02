# Optional receiver blocks

The parser already supported receiver-block shorthand for `value. { ... }`
and `value!. { ... }`, but a nullable receiver followed by `?. {` was routed
through ordinary optional member access. The resulting diagnostic, `Expected
identifier after '?.'`, made a useful DOM pattern such as
`canvas.getContext("2d")?. { fillStyle = "..." }` impossible.

The fix keeps this construct on the shared receiver-block path. The AST marks
the receiver block as an optional call, the type checker removes nullish parts
only for the block's receiver type, and the JavaScript/native emitters guard
the block after evaluating the receiver exactly once. A focused parser test
and runtime test cover both parsing and the non-nullish execution rule.

Investigation initially looked at ordinary optional-call emission, but that
path is not involved: the receiver block is an intrinsic call-shaped AST node
handled before normal call emission. The important regression boundary is the
postfix parser branch ordering, before generic `?.` member parsing.

The follow-up regression exposed a second layer: extension methods were
resolved only for plain named receivers. Optional member access left the
nullable union intact during extension lookup, while non-null asserted access
still reached the emitter with the union-shaped expression type. Shared
extension receiver lookup now ignores nullish union members, and JavaScript
emission guards optional extension calls while evaluating the receiver once.
