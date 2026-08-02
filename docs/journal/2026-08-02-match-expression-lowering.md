# Match expressions lower through the existing conditional path

## Problem

The requested initial `match` syntax is an expression with ordered boolean
conditions, arrow-separated arms, and a fallback arm. It also needs branch
blocks whose final expression supplies the value, without introducing custom
matchers or separate JavaScript and C++ implementations.

## Investigation

The TC39 pattern-matching proposal treats match as an expression whose value is
the selected clause and whose clauses are checked in source order. The do
expressions proposal supplies the relevant block-completion model: a block can
compute a value from its final expression, while declarations and other
non-value statements are only prefixes. An initial emitter-specific
implementation would have duplicated this behavior and risked different
semantics in the two backends.

## Resolution

The initial parser recognized `match { condition -> body }` with optional
`when`. The finalized syntax deliberately separates `condition -> body` from
`when condition: body`, rejecting mismatched keyword/delimiter combinations,
and recognizes `else` or `default` as the final fallback. It immediately
desugars the arm list to the existing nested `IfStatement` expression. This
keeps type checking, control-flow analysis, branch-value handling, and the
continuation-based lowering shared with ordinary `if` expressions. Both
emitters therefore receive the same lowered tree.

The implementation supports a single expression arm, a braced multi-statement
arm whose final expression is its value, and unbraced statement sequences
terminated by the next arm. Later increments added built-in structural matcher
patterns and subject matching through the same lowering; custom matcher
protocols remain intentionally unsupported.

## Regression coverage

Parser tests cover both delimiter forms, `default`, nested arm blocks, and the
lowered AST shape. JavaScript and C++ emitter tests verify ordered conditional
emission and the value of a multi-statement branch.
