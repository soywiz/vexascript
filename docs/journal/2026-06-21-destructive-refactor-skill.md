# Destructive Refactor Skill

## Why this was worth codifying

We kept seeing the same process failure during cleanup work:

- a task was described as unification or DRY
- the implementation added a new shared layer
- but most old layers remained alive

That produced technically improving changes that still felt wrong in shape:

- too much code added
- too little code deleted
- too many compatibility branches preserved
- tests still protecting internal scaffolding instead of real contracts

## Decision

We added a repo-local Codex skill:

- `.codex/skills/destructive-negative-net-refactor/SKILL.md`

Its job is to push future refactors toward:

- negative net line count when practical
- deletion of dead code, not only abstraction over it
- deletion of dead tests when they only protect retired internals
- refusal to preserve internal compatibility layers unless compiler or CLI behavior requires them

## Constraint to remember

For this repository, the important contracts are:

- compiler behavior
- CLI behavior

Not every internal helper signature, return shape, cache, or transitional adapter deserves compatibility protection.

## Expected benefit

This should reduce a recurring failure mode where cleanup work improves local architecture but still increases overall system complexity because old paths survive beside the new one.
