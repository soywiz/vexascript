# Node Modules ESM Unification

## Status

* [ ] Technical debt

## Context

The current bundle pipeline already avoids reparsing local modules after they have been emitted by our own compiler:

* Local `.vx`, `.ts`, and `.tsx` modules are parsed and emitted by the VexaScript compiler first.
* `bundleNodeModuleGraph(...)` then treats those emitted local module sources as final CommonJS-like artifacts and only wraps them in the bundle runtime.

This part is intentional and should stay that way. We do not want to reparse our own emitted JavaScript.

## Current Node Modules Behavior

`node_modules` currently follow three different paths:

* Existing CommonJS modules are kept as-is.
* TypeScript modules from `node_modules` (`.ts`, `.tsx`) are parsed with our TypeScript parser and emitted with our own emitter using `moduleFormat: "commonjs"`.
* JavaScript ESM modules from `node_modules` (`.js`, `.mjs`, `.jsx`) are converted with a lightweight syntax transformer in `cli/nodeModuleBundle.ts`.

The lightweight JavaScript ESM transformer currently rewrites import/export syntax into CommonJS-shaped code well enough for many packages, but it is not a full parser/emitter path.

## Why This Is Debt

The current lightweight ESM-to-CommonJS conversion for JavaScript in `node_modules` has some drawbacks:

* It is pattern-based rather than syntax-tree-based.
* It is more fragile around minified or less common valid ESM forms.
* It duplicates module-format conversion logic that already exists in the main emitter.
* It increases the risk of subtle interoperability bugs around `default`, `__esModule`, re-exports, and formatting variants.

Recent work already needed targeted fixes for:

* Minified imports such as `import{...}from"preact"`.
* Default-export interop for `export { impl as default }`.

These fixes are valid, but they reinforce that the current JavaScript ESM path is still a separate mini-transpiler.

## Desired End State

Move toward a unified rule:

* If a module format conversion is needed, prefer parsing and emitting through our own parser/emitter pipeline.
* Keep true CommonJS passthrough as-is when no conversion is needed.
* Do not reparse local modules that were already emitted by our compiler.

In practice, that likely means:

* Keep local emitted module sources as final artifacts.
* Keep CommonJS `node_modules` modules as passthrough.
* Replace the lightweight JavaScript ESM transformer with a parser/emitter-based conversion path for JavaScript ESM from `node_modules`.

## Constraints

Any future refactor must preserve these rules:

* No synchronous I/O.
* Shared compiler/runtime code must stay browser-compatible except for explicit CLI-only adapters.
* Do not reparse our own already-emitted local JavaScript.

## Suggested Implementation Plan

* [ ] Audit the exact JavaScript ESM forms we still need to support from `node_modules`.
* [ ] Reuse the existing parser/emitter path for `.js`, `.mjs`, and `.jsx` module-format conversion where possible.
* [ ] Keep CommonJS passthrough behavior unchanged.
* [ ] Add regression tests for minified imports, default export variants, re-exports, and mixed named/default imports.
* [ ] Remove the ad hoc ESM conversion helpers from `cli/nodeModuleBundle.ts` once the parser/emitter path fully covers them.
