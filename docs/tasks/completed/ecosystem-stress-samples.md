# Add Ecosystem Stress Samples

## Status

* [x] Completed

## Context

The current sample suite already covers useful cases such as Preact, Pixi, Three.js, Node APIs, local imports, and runtime-language features. It still under-represents several high-pressure JavaScript and TypeScript ecosystem patterns that are important for measuring real-world interoperability:

* hook-heavy React libraries,
* generic-heavy data and validation libraries,
* fluent and chained APIs,
* router and state-machine configuration objects,
* server and CLI frameworks with layered typings,
* and packages whose declaration graphs or runtime entry points are more demanding than the average npm dependency.

If VexaScript wants to feel credible against mainstream TypeScript workflows, we need samples that exercise those shapes deliberately instead of waiting for them to appear incidentally.

## Goal

Expand `samples/` with a focused set of ecosystem stress samples that validate both syntax ergonomics and interoperability with widely used TS-first libraries.

## Candidate Libraries

The first wave should prioritize libraries that cover distinct failure modes rather than many variants of the same pattern.

* [x] `@tanstack/react-query` for hook-heavy generic APIs, options objects, and inferred async data flows.
* [x] `react-router` or `@tanstack/react-router` for typed routing, nested config objects, and React ecosystem entry points.
* [x] `zod` for fluent builder chains, inferred schema types, unions, and strongly type-driven APIs.
* [x] `rxjs` for chained operators, overloads, generics, and functional composition.
* [x] `hono` for server routing, handler typing, context objects, and modern Node/web runtime interop.

Possible follow-up wave:

* [x] `xstate`
* [ ] `d3`
* [x] `zustand`, `valtio`, or `jotai`
* [ ] `yargs` or `commander`
* [ ] `prosemirror` or `codemirror`

## Scope

* [x] Choose a first wave of 3-5 libraries that maximizes distinct syntax and interop coverage.
* [x] Define, for each sample, which VexaScript syntax or compiler/LSP behavior it is meant to stress.
* [x] Add runnable samples under `samples/<name>/` following the existing sample harness contract.
* [x] For browser-oriented samples, include a deterministic `main.vx` plus browser entry files where needed.
* [x] For Node-oriented samples, avoid sync I/O.
* [x] Add focused sample-specific tests where the generic sample harness is not enough.
* [x] Document any ecosystem pain points discovered while building each sample so they can become follow-up compiler/LSP/bundler tasks.
* [x] Update `docs/file.structure.md` for each notable sample added.
* [x] No syntax-reference update was required because the work fixed existing TypeScript interoperability and sample usage without changing VexaScript syntax.

## Current Progress

* [x] Added a focused `samples/react-query/` browser sample that keeps React Query options/result typing isolated from the broader `samples/react/` kitchen-sink sample.
* [x] Added a focused `samples/react-router/` browser sample that keeps MemoryRouter navigation and location-driven JSX isolated from the broader `samples/react/` sample.
* [x] Added a focused `samples/zod/` console sample that validates namespace-style package APIs plus imported schema-driven type extraction through `z.infer`.
* [x] Added `samples/zustand/`, covering curried store factories, callback inference, and subscriptions.
* [x] Added `samples/hono/`, covering route parameters, context variables, request handling, and Web API declarations.
* [x] Added `samples/rxjs/`, covering overload-driven operator composition and observable reduction.
* [x] Added `samples/xstate/`, covering state-machine configuration, actor snapshots, and event-driven context updates.
* [x] Added `samples/tanstack-table/`, covering recursive column definitions and inferred row accessors.
* [x] Added `samples/effect/`, covering namespace barrels, conditional generics, and functional pipelines.
* [x] Added `samples/drizzle/` and `samples/kysely/`, covering mapped database shapes and fluent SQL builders.
* [x] Added `samples/trpc/`, covering recursive router composition, procedure inference, and caller creation.
* [x] Added `samples/viem/`, covering const ABI tuples, conditional validator parameters, tuple mapping, and encoded function data.
* [x] Added `samples/react-hook-form/`, covering recursive form types, utility aliases, callable object aliases, subscriptions, and typed setters.

## Acceptance Criteria

* [x] The sample suite contains at least three new ecosystem stress samples covering clearly different library patterns.
* [x] At least one new sample stresses React ecosystem interoperability.
* [x] At least one new sample stresses generic-heavy non-React typings.
* [x] At least one new sample stresses Node/server or CLI framework interop.
* [x] Each sample has a clear reason for existing and documents the interop or syntax surface it validates.
* [x] New failures found while building these samples are captured in focused regressions, the engineering journal, and the native-emission follow-up task.

## Tests

* [x] Add or update sample tests as needed for each new library.
* [x] Run `pnpm test` (2,789 tests passed).
* [x] Run `pnpm cli vexa testFixtures/sample.vx`.
* [x] Verify the modified React Router, React Query, and Three.js samples in a real browser.

## Related Files

* `samples/`
* `samples/samples.test.ts`
* `.codex/skills/create-vexascript-samples/SKILL.md`
* `docs/file.structure.md`
* `docs/syntax.md`
* `docs/tasks/react-interop-ergonomics.md`
