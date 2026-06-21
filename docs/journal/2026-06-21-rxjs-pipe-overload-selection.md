# RxJS Pipe Overload Selection

## What failed

`rxjs` was still one of the explicitly open ecosystem gaps. We already had some
targeted coverage for:

- sibling named reexports
- variadic tuple helpers
- imported helper aliases

But that did not yet cover a more realistic higher-order observable path:

- `Observable.pipe(map(...), map(...))`

A new focused imported-typing regression for an `rxjs`-style `streamy` package
showed the remaining failure clearly:

- the `pipe` call selected the wrong overload
- the second `map(...)` lost its contextual operator type
- its callback parameter degraded
- downstream observable result typing became wrong too

The visible symptoms included:

- `Expected at most 1 argument(s), but got 2`
- callback parameters collapsing to `void` or unspecialized generic names
- downstream `subscribe` value typing no longer being `string`

## Root cause

The overload selector was still willing to prefer a candidate whose arity was
already incompatible with the written call, as long as its temporary mismatch
score looked cheaper than the more relevant higher-arity candidate.

That was especially harmful for higher-order imported APIs:

- the one-operator `pipe` overload was considered
- the two-operator overload was penalized while contextual typing was still
  being established
- the arity-incompatible overload could still win

Once that happened, the second operator call no longer had the contextual
`OperatorFunction<...>` shape it needed.

## What helped

- Adding a small imported-typing regression in
  `compiler/lsp/nodeModulesTypings.test.ts` was much faster than trying to
  keep a half-working `samples/rxjs/` branch around.
- The useful test shape was not just `of(...).pipe()` or a single `map(...)`.
  The real signal came from two operators in the same `pipe(...)` call because
  that forced overload selection and callback contextual typing to cooperate.

The fix that worked was small and local:

- before scoring overload candidates, prefilter to candidates whose argument
  count is compatible with the written call
- only then run the richer mismatch scoring among those viable candidates

That let the two-operator overload win, which in turn restored contextual
typing for the second operator call and its callback.

## What did not help

- Treating existing RxJS-like reexport and variadic helper tests as sufficient.
  They covered declaration loading well, but not overload selection across a
  realistic higher-order chain.
- Using a brace lambda fixture that accidentally returned `void`. That created
  noise unrelated to the imported-typing bug and had to be corrected before the
  regression became trustworthy.

## Final outcome

We still do not have a checked-in `samples/rxjs/` sample, so the ecosystem task
is not complete yet. But the state is better than before:

- there is now focused regression coverage for a realistic `rxjs`-style
  `pipe(map(...), map(...))` chain
- imported higher-order operator typing survives farther than before
- overload selection no longer silently prefers an arity-incompatible `pipe`
  candidate in that path

This is a good intermediate checkpoint before attempting a full `samples/rxjs/`
addition.

## Regression guidance

- For higher-order imported APIs, do not let overload scoring compare obviously
  arity-incompatible candidates on equal footing with viable ones.
- When an ecosystem library is still blocked, prefer landing a small truthful
  regression first, then grow it into a real sample later.
- In observable/operator ecosystems, always cover at least one chained
  higher-order call where contextual typing must flow from one operator result
  into the next operator input.
