# Declaration-origin barrel symptoms were already fixed

## Context

Started `docs/tasks/unify-declaration-origin-tracking.md`, whose acceptance
criteria are framed around a Pixi bug: go-to-definition for members reached
through an `export *` package barrel landing on the barrel `index.d.ts` instead
of the deep source `.d.ts`.

## Finding

Before touching any navigation code, I wrote two regression tests reproducing
the symptom with a synthetic node_modules package (`index.d.ts` doing
`export * from "./sub"`, the real declaration in `sub/index.d.ts`):

- member definition (`box.width` on an imported class) — lands in the deep file.
- object-literal property definition (`makeText({ fontSize })`) — lands in the
  deep file.

Both **pass already**. The imported-symbol-origin work and the
`nodeModulesTypings` member-location traversal already resolve through barrels to
the owning file. So the task's user-facing symptoms are resolved; there is no bug
left to fix.

## Consequence

The remaining task scope (one shared `DeclarationOrigin` model, removing
feature-local path reconstruction) is now **pure code unification**, not a bug
fix. In a fragile area, that refactor must be justified by regression risk vs.
benefit — it is no longer urgent. Future work here should start subtractive and
keep these two regression tests green as the behavioral contract.

## Lesson

Write the symptom reproduction first. A task framed as a bug fix may already be
fixed by adjacent work; proving that with a test is cheaper and safer than
assuming the bug exists and refactoring a fragile path to "fix" it.
