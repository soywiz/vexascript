# Add Ecosystem Stress Samples

## Status

* [ ] Active

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
* [ ] `rxjs` for chained operators, overloads, generics, and functional composition.
* [ ] `hono` for server routing, handler typing, context objects, and modern Node/web runtime interop.

Possible follow-up wave:

* [ ] `xstate`
* [ ] `d3`
* [ ] `zustand`, `valtio`, or `jotai`
* [ ] `yargs` or `commander`
* [ ] `prosemirror` or `codemirror`

## Scope

* [ ] Choose a first wave of 3-5 libraries that maximizes distinct syntax and interop coverage.
* [ ] Define, for each sample, which VexaScript syntax or compiler/LSP behavior it is meant to stress.
* [ ] Add runnable samples under `samples/<name>/` following the existing sample harness contract.
* [ ] For browser-oriented samples, include a deterministic `main.vx` plus browser entry files where needed.
* [ ] For Node-oriented samples, keep examples asynchronous and avoid sync I/O.
* [ ] Add focused sample-specific tests where the generic sample harness is not enough.
* [ ] Document any ecosystem pain points discovered while building each sample so they can become follow-up compiler/LSP/bundler tasks.
* [ ] Update `docs/file.structure.md` for each notable sample added.
* [ ] Update `docs/syntax.md` if a sample requires or demonstrates newly supported syntax.

## Current Progress

* [x] Added a focused `samples/react-query/` browser sample that keeps React Query options/result typing isolated from the broader `samples/react/` kitchen-sink sample.
* [x] Added a focused `samples/react-router/` browser sample that keeps MemoryRouter navigation and location-driven JSX isolated from the broader `samples/react/` sample.
* [x] Added a focused `samples/zod/` console sample that validates namespace-style package APIs plus imported schema-driven type extraction through `z.infer`.
* [ ] `rxjs` still does not have a checked-in sample, but it now has focused imported-typing regression coverage for `Observable.pipe(map(...), map(...))` style higher-order operator chains.
* [ ] `zustand` is still blocked on curried store-factory inference and imported higher-order callback typing.
* [ ] `hono` is still blocked on imported handler/context typing and overlapping DOM/runtime declaration behavior in its modern web-API-heavy `.d.ts` surface.

## Acceptance Criteria

* [ ] The sample suite contains at least three new ecosystem stress samples covering clearly different library patterns.
* [ ] At least one new sample stresses React ecosystem interoperability.
* [ ] At least one new sample stresses generic-heavy non-React typings.
* [ ] At least one new sample stresses Node/server or CLI framework interop.
* [ ] Each sample has a clear reason for existing and documents the interop or syntax surface it validates.
* [ ] New failures found while building these samples are captured as concrete follow-up tasks instead of staying implicit.

## Tests

* [ ] Add or update sample tests as needed for each new library.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.
* [ ] For browser samples, verify the final UI in a real browser.

## Related Files

* `samples/`
* `samples/samples.test.ts`
* `.codex/skills/create-vexascript-samples/SKILL.md`
* `docs/file.structure.md`
* `docs/syntax.md`
* `docs/tasks/react-interop-ergonomics.md`
