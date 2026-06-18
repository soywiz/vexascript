# Bundle Pipeline Boundaries

This document captures the current bundling split so future refactors can simplify it without losing the intentional phase boundaries that already exist.

## High-Level Flow

The CLI bundle flow is currently a two-stage pipeline coordinated by `cli/cliShared.ts`.

1. `createBundledModuleArtifacts(...)` in `cli/cliShared.ts` loads project/runtime context such as DOM ambient declarations and JSX settings.
2. `bundleModuleGraphAsModules(...)` in `compiler/runtime/moduleGraph.ts` resolves and compiles the local source graph rooted at the entry file.
3. `bundleNodeModuleGraph(...)` in `cli/nodeModuleBundle.ts` takes the already-emitted local entry source plus the local-module source map from step 2, then resolves and wraps remaining package/runtime dependencies into one final ESM bundle.

## Current Phase Ownership

### `compiler/runtime/moduleGraph.ts`

Owns local graph preparation.

Responsibilities:

- resolve local relative imports between `.vx`, `.ts`, `.tsx`, and inline asset files
- parse and compile local source files through the shared compiler pipeline
- provide imported declarations/types from local dependencies and ambient packages to downstream local-module analysis
- emit module-shaped local sources through the VexaScript emitter
- strip now-internal local import/export syntax when local modules are bundled together
- append Vexa/VexaScript-specific implicit runtime exports needed by downstream bundling/runtime consumers
- return:
  - `entrySource`
  - `moduleSources`
  - diagnostics/warnings/errors
  - watched files

It does **not** own final `node_modules` graph traversal or the final runtime wrapper that assembles the full executable bundle.

### `cli/nodeModuleBundle.ts`

Owns package-module traversal and final assembly.

Responsibilities:

- treat `moduleGraph.ts` output as final virtual local sources
- resolve remaining `require(...)` and package specifiers across `node_modules`
- pass through true CommonJS when possible
- transpile remaining package modules when a format conversion is needed
- wrap all bundled modules into the final runtime loader/factory structure
- emit the final single-file ESM bundle

It does **not** re-run semantic analysis for already-emitted local VexaScript modules.

### `cli/cliShared.ts`

Owns orchestration only.

Responsibilities:

- load project configuration
- choose ambient runtime declarations
- forward JSX and external-dependency strategy options
- call the two bundling phases in order
- merge watched-file lists and surface diagnostics/errors

It should stay thin and avoid accumulating conversion logic that belongs in either bundling phase.

## Intentionally Different Paths

The current pipeline still has intentional differences:

- local source files go through the full VexaScript parser/compiler/emitter path first
- already-emitted local modules are not reparsed later
- true CommonJS `node_modules` sources are preserved when no conversion is needed
- JavaScript ESM from `node_modules` prefers the shared parser/emitter path, with a CLI-side fallback retained as a safety net for still-unhandled third-party JavaScript edge cases

Those differences are acceptable today, but they should remain explicit so future bundling work can evolve the pipeline without disturbing the local-module graph contract.

## Refactor Direction

When simplifying this area, preserve these invariants:

- `moduleGraph.ts` remains the source of truth for local graph preparation
- `nodeModuleBundle.ts` remains the source of truth for final package/runtime assembly
- `cliShared.ts` stays orchestration-only
- local emitted module sources are treated as final artifacts, not reparsed
- CommonJS passthrough remains available when no conversion is needed
