# Match pattern lowering battle test

## Context

Pattern matching is implemented as a lowering to ordinary conditionals so JavaScript and C++ share the language semantics without a matcher runtime protocol. Stress tests added structural `is` patterns, subject matches, logical pattern combinations, relational patterns, and branch type narrowing.

## Failures found

### Lowered syntax was lost by the formatter

The parser lowered `match` directly to an `if` expression tree. That was sufficient for emitters and analysis, but the formatter only saw the lowered representation and printed invalid or misleading source.

The durable fix was to retain compact surface-syntax metadata on the lowered root expression. Runtime emitters continue to consume the canonical conditional tree, while the formatter reconstructs `match` from that metadata. A separate formatter-only AST path would have duplicated semantics and was rejected.

### Capturing every subject changed mutation semantics

The first subject-match lowering always used an immediately invoked arrow to evaluate the subject once. For an identifier subject, this shadowed the original variable, so assignment in an arm mutated only the arrow parameter.

Identifier subjects now lower directly to the conditional chain. Non-identifier subjects still use the immediate arrow because they require single evaluation. Runtime tests cover both mutation of an identifier subject and one-time evaluation of a computed subject.

### Structural object shorthand collided with brace-lambda parsing

Inside matcher context, `{ payload }` was interpreted as the language's contextual brace-lambda syntax instead of an object presence pattern. Matcher parsing now forces braces through object-literal parsing. Shorthand properties deliberately mean property presence; pattern bindings remain unsupported.

### Prefix relational patterns collided with JSX parsing

The `<` token in a pattern such as `< 20` reached JSX parsing before a primary expression could represent the omitted left operand. Relational matcher syntax is now recognized in unary parsing while matcher context is active, before JSX interpretation.

### C++ condition wrapping misread immediate lambdas

The C++ emitter's generic condition wrapper treated the first pair of parentheses in an immediate lambda as if it enclosed the entire condition. Nested structural checks then produced invalid native code. Structural matcher captures now emit an additional outer grouping, and the regression is covered by an actual compile-and-run native test rather than only emitter snapshots.

### Tuple narrowing exposed broad numeric index typing

After an array pattern selected one member of a discriminated tuple union, `packet[1]` still produced the union of every tuple element because expression-level numeric indexes were widened to `int` before indexed-access resolution.

Computed member resolution now preserves literal numeric and string index types for built-in indexed access, while operator-overload lookup continues to use the widened expression type. This keeps precise tuple elements without changing overload diagnostics or dispatch.

## Regression strategy

The focused suite now covers parser lowering, semantic diagnostics, hover types, cumulative fallback narrowing, JavaScript execution, formatter round trips, C++ emission, and native compilation. Custom matcher objects, computed object keys, and rest bindings produce explicit diagnostics so they cannot silently acquire accidental semantics. A standalone array `...` is instead a built-in, non-binding variable-length wildcard, implemented directly by both emitters.
