# Modified brace lambdas and source ranges

## Context

Brace lambdas keep `{` as their AST `firstToken` so the formatter and trailing-lambda detection can share the existing brace-lambda path. The `async` and `sync` modifiers are represented by flags on `ArrowFunctionExpression`, including when the modifier appears before a brace lambda inside a call argument list.

## Regression risk

Source edits must not assume that a brace lambda's `firstToken` includes its modifier. The trailing-lambda quick fix originally replaced all text before `{`; doing that for `call(arg, sync { ... })` silently dropped `sync`. Any edit that moves or replaces a modified brace lambda must reconstruct or otherwise preserve the modifier from the AST flags.

Parser, formatter, emitter, full-pipeline, and quick-fix tests now cover both modifier spellings in trailing and argument-list positions.
