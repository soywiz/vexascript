# Vite integration: keep bundling and type checking separate

## Context

The first external Vite sample required deciding whether VexaScript support belonged in the main npm package or in a separately published plugin package. It also exposed a boundary between Vite's per-module transform model and VexaScript's project-aware semantic analysis.

## Decision

The plugin is published from the main package as `vexascript/vite`. Its runtime uses only the VexaScript compiler and Node built-ins, so the root package does not need a Vite dependency or peer dependency. The public declaration file describes the small structural subset of the Vite/Rollup plugin contract that the implementation uses.

Vite owns the module graph, npm dependency resolution, assets, production bundling, and HMR. The VexaScript hook only transforms `.vx` source to ESM and returns its source map. It loads the nearest project configuration for JSX factory settings, while explicit plugin options take precedence.

## Rejected alternatives

### A separate npm package under `plugins/`

This would add release coordination, version compatibility, and discovery overhead without isolating any external runtime dependency. A separate package becomes justified only if future integration code must depend on Vite APIs directly or acquire an independent release cadence.

### Whole-project type checking inside every Vite transform

The single-file transpiler cannot provide correct cross-file imported declarations by itself. Performing semantic validation independently in each transform would either report false unresolved-import errors or require rebuilding a parallel module graph that Vite already owns. The plugin therefore follows Vite's transpilation model and leaves project diagnostics to the language server and explicit CLI checks.

### Reusing the CLI bundle path

Calling the CLI or the VexaScript bundler from the hook would duplicate Vite's graph and lose Vite-native HMR granularity. A dedicated compiler entrypoint keeps one `.vx` input mapped to one ESM output.

## Validation notes

The package build now emits `dist/vite.js`, its source map, and `dist/vite.d.ts`. The external-style sample links the local package, runs a real Vite production build, and renders the generated output in a browser. The first browser pass exposed only a missing favicon request; embedding a data-URL favicon left the final console with the expected application log and no errors or warnings.

The initial preview-server and Playwright launches were denied by the filesystem/network sandbox rather than by application behavior. Running those same bounded localhost operations with explicit approval validated the built output successfully.
