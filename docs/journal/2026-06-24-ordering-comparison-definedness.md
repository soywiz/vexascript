# Ordering comparisons must be "defined" (type-checker / emitter alignment)

## What changed

The type checker now reports `Operator '<' is not defined for types ...` (code
`OPERATOR_NOT_DEFINED`) for the ordering operators `< > <= >= <=>` when the
comparison is not defined — e.g. two unrelated class instances (`Test() <
Test()`) or mismatched primitives (`"test" < 10`). Previously `inferBinaryType`
returned `boolean` (or `int` for `<=>`) unconditionally and no diagnostic fired,
so meaningless comparisons silently type-checked.

A comparison is "defined" when:

- a matching overload applies — a direct one, or `operator<=>` (which derives
  `< > <= >=`); or
- the operands are natively comparable: numeric-with-numeric (including
  int-backed enums), string-with-string, or an `any`/untyped/bare-generic
  operand.

Implementation: `TypeChecker.shouldReportUndefinedComparison` +
`nativeOrderingCategory` + `isUncheckableComparisonOperand`, reported via the
existing `reportMissingOperatorOverload` (same message/format as the arithmetic
path), wired into the `BinaryExpression` handler's no-direct-overload branch.

## Divergence risk to remember

The *runtime* side already knew these rules: `emitter.ts`
`resolveDerivedComparison` derives `< == !=` from `operator<=>`/`operator==`, and
native `<=>` lowers to an inline `($l < $r ? -1 : $l > $r ? 1 : 0)` IIFE. The
type checker did **not** — it accepted everything. That is the classic split
where one surface (emit) encodes a rule the other (diagnostics) ignores.

The two must stay in sync: the diagnostic's "is this defined?" predicate has to
admit exactly the cases the emitter can lower. In particular, the `operator<=>`
derivation is honoured in *both* places. If the lowering ever gains a new derived
comparison (or drops one), update `shouldReportUndefinedComparison` in the same
change, or valid programs will start reporting false `OPERATOR_NOT_DEFINED`
errors (or invalid ones will stop being caught).

## Scope deliberately excluded

Equality (`== != === !==`) and logical (`|| &&`) operators are *not* restricted:
JS gives them meaning for any operands and the user only asked for ordering.
Don't fold them into the ordering predicate without a separate decision.
