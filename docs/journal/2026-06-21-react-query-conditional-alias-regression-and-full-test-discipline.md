# React Query Conditional-Alias Regression And Full-Test Discipline

## What failed

A recent type-checker change improved some imported generic inference paths, but
it also regressed real `@tanstack/react-query` samples:

- `samples/react/`
- `samples/react-query/`
- `samples/lspAllSamples.test.ts`

The visible symptom was that `useQuery({ ... }, queryClient)` started producing
LSP diagnostics like:

- `Argument 1 of type '{ ... }' is not assignable to parameter 'options' of type 'DefinedInitialDataOptions<...>'`
- callback parameters such as `context` collapsed to `unknown`
- result data such as `result.data.title` or `result.data.headline` stopped
  specializing correctly

Separately, I also closed a change before re-running the full repository suite.
That was a process failure even though several focused tests were green.

## Root cause

The type-checker had started expanding conditional type aliases too eagerly in
`expandTypeAliases(...)`.

That is safe for fully concrete aliases, but it is not safe while imported
generic overload inference is still in flight. In the `react-query` case, some
overloads and option helper aliases still depended on open type parameters when
the eager expansion happened. That prematurely collapsed important structure and
left the checker comparing the object literal against a degraded generic shape,
which then poisoned callback inference and result specialization.

The process miss had a simpler root cause: I relied on focused validation and
did not honor the repository rule strongly enough at handoff time.

## What helped

- Running the real failing sample surfaces again was the fastest way to confirm
  the regression was not just in a synthetic unit test.
- `pnpm test -- samples/react.test.ts`
- `pnpm test -- samples/lspAllSamples.test.ts`
- The final proof came from a full `pnpm test`, not from the focused runs.

The code fix that worked was intentionally narrow:

- keep conditional alias expansion
- but only eagerly expand the resolved branch when it no longer contains
  unresolved named references

That preserved the earlier wins for concrete imported conditional aliases while
stopping the regression for generic-heavy overload sets.

## What did not help

- Trying to force a brand-new tiny imported-typings repro that was more
  aggressive than the real `react-query` API shape. It failed for reasons that
  were adjacent to the regression, but not representative enough to be a good
  keeper test.
- Treating several green focused suites as a substitute for the final full run.
  They are useful during development, but they are not release criteria in this
  repo.

## Final outcome

The fix landed in `compiler/analysis/TypeChecker.ts` by making conditional
alias expansion conservative when unresolved generic references are still
present.

The current branch state was validated with the full suite:

- `pnpm test`
- `2082` tests
- `0` failures
- about `16.9s` in the successful run that closed the fix

`AGENTS.md` was also tightened so the workflow requirement is explicit:

- do not finish a task
- do not report success
- do not commit or hand off work
- until `pnpm test` has passed on the current branch state

## Regression guidance

- Be careful with eager alias expansion in imported generic ecosystems.
  Conditional aliases that look harmless in isolation may still be carrying
  unresolved overload inference state.
- When a change touches generic inference, imported declaration expansion, or
  overload selection, always recheck at least one real ecosystem sample in
  addition to focused unit coverage.
- In this repository, the final authority before closing work is the full
  `pnpm test` run, not a collection of focused green checks.
