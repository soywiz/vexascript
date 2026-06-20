# React Sample LSP Rehabilitation

## What failed

The `react` sample opened with LSP error diagnostics even after imported
`@tanstack/react-query` typings were mostly working. The remaining visible
error was a nullable access on `roadmapData.checks` after an early-return
guard:

- `if (!roadmapData) { return ... }`
- `val checks = roadmapData.checks`

## Root cause

Two separate type-system gaps combined:

1. Generic inference across imported declaration files was not expanding named
   type aliases early enough, so callback types such as
   `QueryFunction<T> = (...) => T | Promise<T>` failed to infer `T` correctly.
2. Flow narrowing only applied inside `if` branches. When one branch always
   exited, the checker did not propagate the opposite narrowing into the
   following fallthrough code.

## What helped

- Reproducing the sample failure in a focused imported-typings test was much
  faster than iterating through the full sample.
- Re-running a real fake-LSP open session remained important after the unit
  fix, because the sample still exposed the missing fallthrough narrowing.

## Regression guidance

- When imported generic APIs return nullable data and user code guards with an
  early return, cover both:
  - imported generic inference
  - post-guard flow narrowing
- If a sample exposes a type-system bug, keep the sample as broad coverage but
  also add a small checker test that isolates the semantic rule.
