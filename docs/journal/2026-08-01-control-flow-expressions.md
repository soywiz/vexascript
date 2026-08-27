# Control-flow expressions require pre-emission lowering

## Problem

VexaScript modeled `if`, `return`, `throw`, `break`, and `continue` only as
statements. Accepting them in expression grammar was not sufficient because
JavaScript has no general statement-expression form, and a helper lambda would
change which function or loop a `return`, `break`, or `continue` targets.

## Cause

The AST separated `Expr` and `Statement` into sibling base classes, so a single
control-flow node could not participate in both semantic paths. The JavaScript
and C++ emitters also received expression trees directly, after only structural
lowering for features such as ranges and `defer`.

## Resolution

- Make `Expr` a statement-shaped AST base while continuing to wrap ordinary
  source expressions in `ExprStatement`. The five control-flow nodes can now
  share one identity in statement and expression positions.
- Type terminal control-flow expressions as `never` and validate them with the
  enclosing function, loop, switch, and label context.
- Lower control-flow expressions through the shared lowering pass before either
  backend. The continuation-based transformation preserves short-circuiting,
  branch values, evaluation order, and native target statements.
- Use collision-free generated bindings and semantic type names for hoisted
  result variables so C++ keeps concrete storage types.
- Include nested return expressions in inferred function return types and keep
  expression-bodied arrows inside their own flow context.

## Follow-up: logical result types and continuation narrowing

The initial implementation correctly lowered operand-valued logical control
expressions at runtime, but the pre-existing binary type inference still
reported every `&&` and `||` expression as `boolean`. This made
`array[index] || throw Error("Not found")` execute correctly while exposing the
wrong type to assignments and the LSP.

Logical inference now models the reachable operand branches. Truthiness
narrowing handles nullish members and representable falsy literals, `never`
branches are removed structurally, and `??` uses the corresponding non-nullish
branch. Normal completion after an abrupt right operand also updates the flow
scope, so guards such as `value ?? continue` and `payload.name || throw ...`
narrow later uses. Optional element-array syntax (`T?[]`) required a parser
disambiguation based on token adjacency so it would not consume the `?` in a
conditional type whose true branch begins with a tuple.

## Investigation notes

Immediately invoked functions work for a `throw` expression but were ruled out
for the general feature: `return` would return from the helper, while `break` and
`continue` cannot cross a function boundary. Encoding control transfer as hidden
exceptions was also rejected because user `catch` blocks would observe the
signals unless every catch path were rewritten, and C++ return values would need
additional type-erased transport. A shared pre-emission lowering keeps the
existing native control-flow semantics and avoids backend-specific runtime
protocols.
