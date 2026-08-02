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

### Pattern captures needed one branch-local lowering

Typed and inferred captures initially looked like an emitter feature, but doing
that independently in JavaScript and C++ would have duplicated scoping and
value-path logic. The parser now represents `val name` and `val name: Type` as
matcher nodes, then prepends ordinary branch-local variable declarations to the
already shared lowered `if` body. Array suffix captures after a standalone
`...` compute their index from the end, while nested object and array captures
reuse ordinary member expressions. Analysis therefore sees the same narrowed
subject and ordinary declaration types that editor features already understand.

Primitive names are classified by one shared helper. JavaScript emits `typeof`
for `string`, `number`/`int`, `boolean`, and `bigint`/`long`; C++ emits the
corresponding `vexa::Value` kind checks. Other identifiers remain nominal class
patterns, preserving the basic `is`/`instanceof` contract without introducing a
custom matcher protocol.

### A regex arm followed by a relational arm merged across lines

The broader syntax-tour sample placed `/regexp/ -> ...` immediately before
`>= 10 and < 20 -> ...`. Ordinary expression parsing consumed the leading
`>=` as a continuation of the previous arm body before the match parser could
recognize a new arm. Match-body binary parsing now stops at a line break only
when speculative matcher parsing proves that the relational sequence ends in a
valid arm delimiter. This keeps multiline comparisons valid while separating
real relational arms.

### Incomplete RegExp member access bypassed AST completion

`/.el.*/.` tokenized correctly, and the runtime declarations already contained
`RegExp.test`, `exec`, `source`, and `lastIndex`, but the incomplete member-access
recovery rejected any receiver whose source text ended in `/`. Allowing `/` in
the shared receiver-tail classifier restores the normal declaration-driven
member completion path; no RegExp-specific completion list was added.

### Rest-parameter context leaked the array type into match arms

Passing a match expression directly to a variadic function exposed a contextual
typing bug that did not appear when the same match was first assigned to a
variable. Call arguments were checked against the rest parameter's declared
array type instead of its element type, so every match arm was incorrectly
required to return `any[]`. Call-argument contextual typing now unwraps rest
parameter element types through one shared helper. A regression test passes a
numeric match result directly to `console.log`, and the browser playground
exercise verifies that the same path executes successfully.

## Regression strategy

The focused suite now covers parser lowering, semantic diagnostics, hover types,
cumulative fallback narrowing, branch-local typed and inferred captures,
variable-length prefix and suffix captures, JavaScript execution, formatter
round trips, RegExp literal completion, C++ emission, and native compilation.
Custom matcher objects, computed object keys, object rest, and array rest
bindings remain unsupported. A standalone array `...` is instead a built-in,
non-binding variable-length wildcard implemented directly by both emitters.
