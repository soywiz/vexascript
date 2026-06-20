# Preact Sample LSP Rehabilitation

## What changed

The global sample LSP sweep no longer skips the `preact` sample.

The actual fix was not in the sample. It was in cross-file LSP type
resolution:

- `classResolverMemberShapes` now infers class-field types from initializers
  when no explicit annotation exists and analysis data is available.
- `classResolver` now specializes inherited generic node_modules class members
  from subclass-owned field types, which fixes `class Clock extends Component`
  patterns such as Preact stateful components.
- `typeNames.substituteTypeNameText()` now substitutes generic parameters
  inside complex function and union type text instead of only simple
  `Base<T>`-style shapes.
- `isTypeAssignableByName()` now recognizes object literals as assignable to
  `Partial<{ ... }>` and unwraps `Readonly<T>` when checking string-based
  cross-file assignability heuristics.

## Reproduction

The bug was first visible in the real sample, but it was reproduced in a fast
isolated test:

- imported `preact-like` declaration file
- merged `interface Component<P = {}, S = {}>` plus `abstract class Component<P, S>`
- subclass with `var state = { time: Date.now() }`
- `this.setState({ time: Date.now() })`

That isolated cross-file test failed before the fix with a bogus error that
treated the `setState` parameter as unresolved `P`/`S` text.

After the fix:

- the isolated regression test passes
- `samples/lspAllSamples.test.ts` passes with `preact` enabled
- the real `preact` sample opens without LSP error diagnostics

## Unsuccessful Paths

- `nodeModulesTypings`-only reproductions were explored first because the
  symptom looked like a generic typing import failure. They were insufficient:
  the imported-typings path was already healthy, so those tests stayed green
  while the real bug remained.
- The initial hypothesis was that merged Preact defaults on
  `interface Component<P = {}, S = {}>` were simply not being applied to the
  `class Component<P, S>`. That was only part of the story. It explained why
  the case looked suspicious, but it did not explain the failing LSP path by
  itself because several reduced tests around merged defaults already passed.
- Another tempting branch was to treat the sample itself as the problem and add
  explicit type arguments or extra annotations in the sample. That route was
  rejected because it would only hide the real compiler/LSP bug and would not
  satisfy the project goal that real user-facing code should work unchanged.
- Before the final fix, a first resolver change specialized inherited members
  from subclass field types, but the regression still failed. That dead end was
  useful because it revealed a second missing piece: generic substitutions were
  not being applied inside complex function/union type text such as Preact's
  `setState` signature.

## Lesson

When a large sample fails, do not stop at the sample-level symptom. Reproduce
the failure in the same infrastructure layer that is actually wrong. Here the
main semantic analysis path was already clean; the broken behavior lived in the
cross-file LSP fallback path, so a focused regression test there was the right
long-term protection.
