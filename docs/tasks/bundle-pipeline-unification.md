# Bundle Pipeline Unification

## Status

* [ ] Technical debt
* [~] In progress: implicit Vexa export planning for module-graph ESM and CommonJS-shaped outputs now shares one helper (`compiler/runtime/implicitExports.ts`) instead of keeping two parallel rule sets inside `moduleGraph.ts`.

## Context

The bundle pipeline is now in a much better place than before:

* local VexaScript and TypeScript modules are compiled through the VexaScript parser/emitter path
* already-emitted local modules are not reparsed later
* `dist/vexa.js` is the single CLI artifact
* `bundleNodeModuleGraph(...)` wraps bundled modules into one final ESM output

That said, the full bundling story is still split across different layers:

* `compiler/runtime/moduleGraph.ts`
* `cli/nodeModuleBundle.ts`
* `cli/cliShared.ts`

and those layers still use different strategies depending on module origin and file type.

## Why This Is Debt

The current split is understandable, but still costs architectural clarity:

* local module preparation and package-module bundling live in different layers
* CommonJS and ESM conversion responsibilities are not fully centralized
* JavaScript modules from `node_modules` still take a different conversion route from TypeScript modules
* module export planning exists in more than one conceptual place

This is acceptable in the short term, but it leaves the bundler harder to evolve than the rest of the compiler.

## Relationship To Other Debt

See also:

* `docs/tasks/node-modules-esm-unification.md`

That task is narrower and focuses specifically on JavaScript ESM from `node_modules`.

This task is broader and focuses on the overall bundle pipeline architecture.

## Desired End State

A clearer bundling architecture with explicit boundaries:

* local source graph preparation
* module-format conversion
* package-module wrapping
* final bundle assembly

The goal is not to force everything through one giant path. The goal is to make the differences intentional, documented, and minimal.

## Suggested Tasks

* [x] Document the exact phase boundaries between `moduleGraph.ts` and `nodeModuleBundle.ts`.
  - See `docs/bundle.pipeline.md` for the current ownership split between `compiler/runtime/moduleGraph.ts`, `cli/nodeModuleBundle.ts`, and `cli/cliShared.ts`.
* [ ] Minimize bundling-specific logic inside otherwise generic compiler emission code.
* [~] Consolidate export-planning rules so implicit/runtime/public export behavior has one obvious source of truth.
  - `compiler/runtime/implicitExports.ts` now centralizes the implicit Vexa export plan used by both `appendImplicitVexaExports(...)` and `appendImplicitVexaCommonJsExports(...)` inside `moduleGraph.ts`.
* [ ] Reduce the number of format-conversion strategies used during bundling where practical.
* [ ] Add focused tests that pin each bundling phase independently, not only end-to-end bundle output.
* [ ] Revisit whether some wrapper-generation logic should move to a dedicated bundling module instead of staying in mixed CLI/runtime files.
