# Match common branch operation quick fixes

## Motivation

Exhaustive standalone matches often repeated the same control or write
operation in every arm even though only the produced value varied. Typical
examples returned a color from every branch or assigned every branch result to
the same field.

## Implementation

The existing conditional rewrite provider now offers two additional quick
fixes:

- `Move return outside match` rewrites per-arm `return value` operations to one
  `return match { ... }` expression.
- `Move assignment outside match` rewrites per-arm `target = value` operations
  to `target = match { ... }`.

Both fixes require a standalone match with an `else` or `default` arm. Every
arm must contain exactly the same operation shape, and assignments must use
plain `=` with the same stable identifier or non-computed member chain. This
avoids changing fallthrough behavior or moving side-effectful assignment-target
evaluation ahead of the match. Single-statement blocks are supported only when
removing their braces cannot discard comments or other source text.

Focused coverage includes condition and subject matches, direct and blocked
returns, stable member assignments, missing fallbacks, mixed operations,
different targets, side-effectful targets, and comment preservation.

## Implicit terminating if chains

Consecutive standalone `if` statements are now eligible for the existing
if-chain-to-match quick fix when every branch ends in `return` or `continue`.
The terminating operation makes the statements mutually exclusive even though
the source omits `else`. An immediately following `return` is consumed as the
optional fallback; otherwise later statements remain outside the generated
match.

The shared subject detector now recognizes both `==` and `===`. Consequently,
chains that repeatedly compare the same stable expression, such as
`kind === "player"`, produce `match (kind)` rather than a condition match that
repeats `kind` in every arm. Source gaps are accepted only when they contain
whitespace or semicolons, preventing the range rewrite from deleting comments.

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: Unavailable (not exposed by runtime)
