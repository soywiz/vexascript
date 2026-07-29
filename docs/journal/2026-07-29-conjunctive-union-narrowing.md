# Conjunctive union narrowing

The false branch of `A && B` is a disjunction of the operands' false facts.
When both facts constrain the same stable expression, their union is safe and
useful. Without that merge, an `else` after two inequality checks retained a
third discriminant variant that both checks had excluded.
