# Disjunctive union narrowing

For a true `A || B` condition, a stable expression narrowed by both operands
must retain the union of those two narrowed types. Leaving no map discarded
useful facts such as `kind === "a" || kind === "b"`. Only keys narrowed by
both sides are safe to retain, because a one-sided fact need not hold when the
other disjunct made the condition true.
