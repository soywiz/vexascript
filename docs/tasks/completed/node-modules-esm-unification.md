# Node Modules ESM Unification

## Status

* [x] Completed

## Context

The current bundle pipeline already avoids reparsing local modules after they have been emitted by our own compiler:

* Local `.vx`, `.ts`, and `.tsx` modules are parsed and emitted by the VexaScript compiler first.
* `bundleNodeModuleGraph(...)` then treats those emitted local module sources as final CommonJS-like artifacts and only wraps them in the bundle runtime.

This part is intentional and should stay that way. We do not want to reparse our own emitted JavaScript.

## Current Node Modules Behavior

`node_modules` now follow two intentionally different paths:

* Existing CommonJS modules are kept as-is.
* TypeScript and JavaScript ESM modules from `node_modules` (`.ts`, `.tsx`, `.js`, `.mjs`, `.jsx`) are parsed with our TypeScript parser and emitted with our own emitter using `moduleFormat: "commonjs"`.

This keeps JavaScript ESM on the same parser/emitter conversion path as the rest of the compiler-supported module formats without reparsing already-emitted local modules.

## Why This Was Debt

The previous lightweight ESM-to-CommonJS conversion for JavaScript in `node_modules` had some drawbacks:

* It was pattern-based rather than syntax-tree-based.
* It was more fragile around minified or less common valid ESM forms.
* It duplicated module-format conversion logic that already exists in the main emitter.
* It increased the risk of subtle interoperability bugs around `default`, `__esModule`, re-exports, and formatting variants.

## Final State

The bundler now applies one unified rule for non-CommonJS `node_modules` modules:

* If a module format conversion is needed, parse and emit through our own parser/emitter pipeline.
* Keep true CommonJS `node_modules` sources as passthrough.
* Do not reparse local modules that were already emitted by our compiler.

## Constraints Preserved

The completed work still preserves the original constraints:

* No synchronous I/O.
* Shared compiler/runtime code stays browser-compatible except for explicit CLI-only adapters.
* Already-emitted local JavaScript is not reparsed.

## Completed Work

* [x] Audit the exact JavaScript ESM forms we still needed to support from `node_modules`.
  - Coverage now includes named imports, default imports, namespace imports, mixed default+named imports, side-effect imports, named exports, default export expressions/functions/classes, `export { name as default }`, named re-exports, `export *`, `export * as ns from "..."`, named/anonymous class expressions, computed class fields, regular-expression default exports, trailing-dot decimals, and additional compound assignment operators such as `^=`.
* [x] Reuse the existing parser/emitter path for `.js`, `.mjs`, and `.jsx` module-format conversion.
  - `cli/nodeModuleBundle.ts` now routes JavaScript ESM straight through `parseSource(...)` plus `emitProgram(...)` with `moduleFormat: "commonjs"`.
* [x] Keep CommonJS passthrough behavior unchanged.
  - `shouldPreserveCommonJsSource` still detects CommonJS markers and short-circuits before any transformation.
* [x] Add regression tests for the real-world JavaScript forms that previously required the fallback.
  - Added parser, tokenizer, and bundler coverage for anonymous default exports, class expressions, computed class fields, regular-expression exports, trailing-dot decimals, and `^=` assignment.
* [x] Remove the ad hoc ESM conversion helpers from `cli/nodeModuleBundle.ts`.
  - The lightweight JavaScript ESM fallback helpers were deleted once the shared parser/emitter path covered the remaining sample-package gaps. The full test suite and CLI validation now pass with the fallback removed.
