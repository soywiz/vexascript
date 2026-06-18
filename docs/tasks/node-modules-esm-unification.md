# Node Modules ESM Unification

## Status

* [~] Mostly complete; remaining: parser/emitter still needs broader third-party JavaScript coverage before the fallback can be removed

## Context

The current bundle pipeline already avoids reparsing local modules after they have been emitted by our own compiler:

* Local `.vx`, `.ts`, and `.tsx` modules are parsed and emitted by the VexaScript compiler first.
* `bundleNodeModuleGraph(...)` then treats those emitted local module sources as final CommonJS-like artifacts and only wraps them in the bundle runtime.

This part is intentional and should stay that way. We do not want to reparse our own emitted JavaScript.

## Current Node Modules Behavior

`node_modules` currently follow three different paths:

* Existing CommonJS modules are kept as-is.
* TypeScript modules from `node_modules` (`.ts`, `.tsx`) are parsed with our TypeScript parser and emitted with our own emitter using `moduleFormat: "commonjs"`.
* JavaScript ESM modules from `node_modules` (`.js`, `.mjs`, `.jsx`) try the shared parser/emitter path first and still retain a lightweight fallback in `cli/nodeModuleBundle.ts` when real-world third-party JavaScript hits parser gaps.

This keeps more JavaScript ESM on the same parser/emitter conversion path as the rest of the compiler-supported module formats, while still preserving compatibility for edge cases through the fallback.

## Why This Is Debt

The previous lightweight ESM-to-CommonJS conversion for JavaScript in `node_modules` had some drawbacks:

* It is pattern-based rather than syntax-tree-based.
* It is more fragile around minified or less common valid ESM forms.
* It duplicates module-format conversion logic that already exists in the main emitter.
* It increases the risk of subtle interoperability bugs around `default`, `__esModule`, re-exports, and formatting variants.

Earlier work needed targeted fixes for:

* Minified imports such as `import{...}from"preact"`.
* Default-export interop for `export { impl as default }`.

Those cases are now covered by the shared parser/emitter path instead of a separate mini-transpiler.

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

* [x] Audit the exact JavaScript ESM forms we still need to support from `node_modules`.
  - Verified coverage for named imports, default imports, namespace imports, mixed default+named imports, side-effect imports, named exports, default export expressions/functions/classes, `export { name as default }`, named re-exports, `export *`, and `export * as ns from "..."`.
* [x] Reuse the existing parser/emitter path for `.js`, `.mjs`, and `.jsx` module-format conversion where possible.
  - `cli/nodeModuleBundle.ts` now covers more JavaScript ESM through the shared parser/emitter path first, including namespace re-exports, while still preserving the fallback for parser gaps surfaced by real third-party packages.
* [x] Keep CommonJS passthrough behavior unchanged.
  - `shouldPreserveCommonJsSource` detects CommonJS markers and short-circuits before any transformation.
* [x] Add regression tests for minified imports, default export variants, re-exports, and mixed named/default imports.
  - `compiler/runtime/nodeModuleBundle.test.ts` covers both end-to-end bundle scenarios and direct unit tests of `transpileModuleSource`, `shouldPreserveCommonJsSource`, `detectStaticRequires`, and `collectCommonJsExports`.
* [~] Remove the ad hoc ESM conversion helpers from `cli/nodeModuleBundle.ts` once the parser/emitter path fully covers them.
  - `export * as ns from "..."` is no longer a blocker, but real third-party JavaScript still hits parser gaps (for example minified control-flow/expression boundaries). The fallback remains intentionally available until those cases are covered by the shared parser/emitter path.
