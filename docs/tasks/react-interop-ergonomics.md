# Improve React Interop Ergonomics

## Status

* [ ] Active

## Context

Building `samples/react/` exposed a clear gap between writing UI logic in VexaScript and integrating with the real React ecosystem.

The component code itself felt compact and readable, especially for local state updates and JSX structure. The friction showed up once the sample had to interact with actual React and ReactDOM packages, browser-safe bundling, and package typings.

Compared with ordinary TypeScript React projects, the current VexaScript experience required extra workarounds:

* normal React and ReactDOM imports were not the most stable browser path for the sample,
* `typeof import("react")` style module typing did not fit naturally into the sample authoring flow,
* typed access to runtime globals such as `globalThis.React` and `globalThis.ReactDOM` required manual bridging,
* browser bundling of React and ReactDOM surfaced runtime issues such as `React.createElement is not a function` and `process is not defined`,
* newer React entry points such as `react-dom/client` were not as straightforward to use as in a standard TypeScript setup.

The result is that VexaScript can feel more pleasant than TypeScript for the UI code itself, while still feeling worse than TypeScript for React ecosystem interop. That is the gap this task should close.

## Goal

Make React usage in VexaScript feel as close as practical to the normal TypeScript authoring experience:

* import React packages directly,
* rely on package typings without awkward inline bridging,
* bundle browser-safe React code without sample-specific workarounds,
* and keep the resulting source readable and minimal.

## Scope

* [ ] Document the exact interop pain points observed in `samples/react/` and turn them into regression requirements.
* [ ] Make direct React and ReactDOM imports work reliably in browser-oriented VexaScript samples.
* [ ] Support a clean typed authoring path for React modules without forcing manual `globalThis` bridges in sample code.
* [ ] Revisit support for `typeof import("...")` and other module-type authoring patterns if they are meant to be first-class in VexaScript source.
* [ ] Ensure React browser bundles do not rely on Node-only globals such as `process` unless they are intentionally shimmed through a browser-safe path.
* [ ] Improve compatibility with ReactDOM browser entry points, including `react-dom/client`, where the ecosystem expects them.
* [ ] Keep the implementation asynchronous and browser-compatible, following repository policy.
* [ ] Update `docs/syntax.md` if the final solution adds or clarifies supported module-typing syntax.
* [ ] Update `docs/file.structure.md` if the final solution introduces a new bundling, interop, or declaration-loading module.

## Acceptance Criteria

* [ ] `samples/react/` can use direct React and ReactDOM imports without relying on sample-local runtime global bridges.
* [ ] The React sample can use package typings from `@types/react` and `@types/react-dom` through a natural authoring flow.
* [ ] A browser-oriented React sample bundles and runs without `React.createElement is not a function`.
* [ ] A browser-oriented React sample bundles and runs without `process is not defined`.
* [ ] ReactDOM entry points used by normal React apps, including client rendering paths, are practical to use from VexaScript.
* [ ] The resulting React sample source is no more awkward than the current workaround version and ideally simpler.

## Tests

* [ ] Add regression coverage for the React sample using direct React imports in browser bundles.
* [ ] Add coverage for whichever typed module-authoring pattern becomes the preferred React path.
* [ ] Add a browser-facing regression that proves the bundled React sample renders successfully.
* [ ] Run `pnpm test`.
* [ ] Run `pnpm cli vexa testFixtures/sample.vx`.

## Related Files

* `samples/react/`
* `compiler/project.ts`
* `compiler/runtime/transpile.ts`
* `compiler/runtime/moduleGraph.ts`
* `cli/nodeModuleBundle.ts`
* `compiler/lsp/nodeModulesTypings.ts`
