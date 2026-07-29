# Compound conditional narrowing

The compiler already calculated narrowing facts for compound logical
conditions, but conditional expressions gated those facts behind a predicate
that recognized only a top-level comparison. Treating `&&` and `||` as
compositional narrowing conditions lets ternary branches use the same scoped
facts as `if` branches.
