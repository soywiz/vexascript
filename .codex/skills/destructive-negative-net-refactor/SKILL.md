---
name: destructive-negative-net-refactor
description: Perform subtractive VexaScript refactors where the net line count should usually go down, prioritizing deletion of dead or duplicated code, removal of internal compatibility layers, and unification around the real external contracts: the compiler behavior and the CLI. Use when simplifying architecture, converging parallel code paths, deleting stale helpers or tests, or replacing migration scaffolding with one canonical implementation.
---

# Destructive Negative-Net Refactor

Use this skill when the goal is cleanup by deletion, convergence, and simplification, not feature growth.

## Core rule

The real contracts are:

- compiler behavior
- CLI behavior

Do not preserve internal compatibility layers just because tests, helpers, or old call sites still mention them. If an internal adapter, parallel map, transitional parameter, or compatibility facade is no longer needed to preserve compiler or CLI behavior, prefer deleting it.

## Success criteria

A good result here usually has most of these properties:

- net line count is negative
- one canonical code path replaces several parallel ones
- public or shared helper signatures get smaller, not larger
- tests are updated to assert the canonical structure, not the retired plumbing
- validation still passes with `pnpm test` and `pnpm cli vexa testFixtures/sample.vx`

If the change adds much more code than it removes, assume the refactor is incomplete unless there is strong evidence otherwise.

## Workflow

1. Find the real contract.
   Decide what must stay behaviorally stable for users: compiler output, diagnostics, LSP behavior that users see, CLI flows, sample behavior.
2. Identify internal duplication.
   Look for parallel maps, fallback code paths, old constructors with too many parameters, wrappers that only translate between two internal shapes, and tests that exist only to prop up those legacy shapes.
3. Choose the canonical representation.
   Pick the smallest shared model that can serve all still-valid user-facing behavior.
4. Delete old paths early.
   Prefer removing compatibility parameters, compatibility return fields, and adapters in the same change instead of adding a new model beside them.
5. Repair callers and tests to the canonical path.
   Update production code first, then rewrite tests to assert the new source of truth.
6. Validate the real contracts.
   Always run `pnpm test` and `pnpm cli vexa testFixtures/sample.vx` before finishing.

## How to detect dead code

Treat code as a deletion candidate when most of these are true:

- it is only referenced by tests
- production code no longer calls it directly
- it only mirrors data already available in a richer canonical structure
- it exists to preserve an internal API shape rather than user-visible behavior
- removing it shrinks signatures or state duplication without changing compiler or CLI behavior

Useful signals:

- `codegraph_callers` shows callers only from tests
- `rg` finds references only under `*.test.ts`, `validation/`, or fixture helpers
- the code is a derived view of another already-shared structure
- it is only used to bridge old and new internal representations during a migration that is effectively finished

## How to detect duplicated live code

Look for:

- several maps carrying the same information in narrower forms
- feature-specific reconstruction of information already computed earlier
- local fallback logic that re-derives ownership, types, or declaration origins
- constructors or factories with long positional argument lists that exist only because several internal shapes are kept alive
- multiple helpers with the same responsibility but slightly different data sources

When two live paths do the same job, prefer one source of truth and delete the others instead of keeping them synchronized.

## Deleting tests is valid

Deleting tests is correct when the deleted tests only protect dead code or retired internal compatibility layers.

Good deletions:

- tests that exist only for a removed helper or adapter
- tests that assert a legacy internal return shape after production code has moved to a canonical one
- tests whose only purpose was preserving a bridge layer you intentionally removed

Do not keep obsolete tests just because they pass. Old tests can freeze bad architecture.

Replace them with tests that protect the real contract:

- observable compiler behavior
- CLI behavior
- real user-facing LSP behavior
- the canonical internal structure when it is now the shared production source of truth

## Compatibility policy

Do not maintain internal compatibility for:

- transitional helper parameters
- legacy return fields
- parallel state caches
- old internal names kept only to reduce local diff size

Internal compatibility is a cost. Keep it only when removing it would break a real external contract in the same change.

## Smells that mean “delete more”

- the new abstraction exists, but old callers still use the legacy one
- the diff adds a new shared model but keeps old fields, maps, and adapters
- tests still instantiate the old shape “for convenience”
- production code reads both the old and new representations
- comments say “temporary”, “compat”, “legacy”, or “fallback” without an active external need

## Validation

Before finishing:

- run `pnpm test`
- run `pnpm cli vexa testFixtures/sample.vx`
- mention any deliberately deleted dead tests in the summary
- mention the main compatibility layer or duplicate representation that was removed
