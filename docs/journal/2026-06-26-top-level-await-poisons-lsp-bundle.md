# Top-level await in a shared module poisons the packaged LSP bundle

## Symptom

The published VS Code extension's language server crashed in a restart loop:

```
Warning: Detected unsettled top-level await at .../dist/vexa.mjs:30233
await init_importedDeclarations();
[Error] Server process exited with code 13.
```

## Root cause

`compiler/runtime/ecmascriptDeclarations.ts` eagerly preloaded the runtime
declaration programs at import time with a module-scope `await` (guarded by an
`if`, but the `await` keyword still sits at module scope):

```ts
if (shouldPreloadRuntimeDeclarationsAtImportTime()) {
  await import("./ecmascriptDeclarations.shared").then(({ ensureEcmaScriptRuntimeProgram }) =>
    ensureEcmaScriptRuntimeProgram());
  ...
}
```

A single top-level `await` makes the **whole module** a top-level-await (TLA)
module. esbuild then marks **every transitive importer** async and emits
`await init_<module>()` chains across the bundle. In the packaged ESM server
bundle Node reports "Detected unsettled top-level await" and exits with code 13.

The earlier band-aid — gating the preload on `process.argv[1]` (`/dist/vexa.js`,
later also `/dist/vexa.mjs`) — does **not** help: the `await` keyword's presence
poisons the bundle regardless of whether the guarded branch executes at runtime.

## Why it survived for so long

Node's test runner executes each test file in its **own process**. The eager
preload lived in the Node *wrapper* (`ecmascriptDeclarations.ts`), which most
analysis/transpile tests import transitively (via Binder/TypeChecker). Node
*awaits* a module-graph top-level await before running the test body, so the
synchronous getters (`getEcmaScriptRuntimeProgram()`) were always ready in tests.
That made the TLA look harmless — it only bit the bundled server.

## Initial fix

1. Remove the import-time preload (and the dead `argv1` guard) from
   `compiler/runtime/ecmascriptDeclarations.ts`. No shipped module uses
   top-level await.
2. Load the declarations explicitly from each async entry point, before any
   synchronous getter is reachable, via a single browser-safe helper
   `ensureCompilerRuntimePrograms()` in `compiler/runtime/ensureRuntimePrograms.ts`:
   - CLI: `cli/cliShared.ts` (already called by build/bundle/run/serve paths).
   - MCP server: awaited at the top of `runMcpServer` (it builds analysis
     sessions per request with synchronous getters).
   - LSP server: awaited inside the `initialize` handler. Capability/flag side
     effects stay synchronous; only the *returned* initialize response is gated
     on the load. The LSP client waits for that response before sending any
     request, so it is a deterministic preload point that needs no TLA.
   - Tests: a root `before()` hook in `compiler/test/expect.ts` (NOT a top-level
     await — plugin tests transpile to CJS where TLA is unsupported, and the
     shipped compiler forbids TLA). The test runner awaits the hook before the
     file's tests.

## Dead ends explored

- **`void import(...).then(ensure)` (fire-and-forget) in the wrapper.** Removes
  the TLA but makes the preload race: ~30 analysis/LSP/transpile tests call the
  synchronous getter before the background load resolves and fail with
  "runtime declarations have not been loaded". Rejected — the load must be
  awaited somewhere deterministic, not fire-and-forget.
- **Top-level await in `compiler/test/expect.ts`.** Works for the main suite but
  the `plugins/vscode/*.test.ts|js` files are bundled by esbuild to **CJS**,
  where top-level await is a hard transform error
  (`Top-level await is currently not supported with the "cjs" output format`).
  Replaced with a root `before()` hook.

## Lessons / guards

- Treat a module-scope `await` anywhere (even inside `if`) as poisoning the
  whole bundle. The repo rule "Do not use top-level awaits as they are
  problematic" exists precisely for this failure mode.
- A guard that checks `process.argv[1]` cannot neutralize a TLA — only removing
  the `await` keyword from module scope does.
- When a preload only "works" because Node awaits a module-graph TLA during test
  loading, that is a smell: the same code can deadlock once bundled. Prefer an
  explicit awaited init at each entry point.
- `cli.test.ts` already asserts `built CLI starts without unsettled top-level
  await warnings`; the server bundle deserves the same kind of smoke check.

## Follow-up simplification

The explicit entry-point preload was better than a module-scope await, but it
still preserved the underlying fragility: every CLI/LSP/MCP/test surface had to
remember to call the same async helper before any synchronous getter could run.
That was still a compatibility layer around synchronous compiler internals.

The durable simplification is to embed the ECMAScript and VexaScript runtime
declaration source text in `compiler/runtime/embeddedRuntimeSources.ts`, then let
`getEcmaScriptRuntimeProgram()` and `getVexaScriptRuntimeProgram()` parse lazily
from those constants. The compiler still performs no synchronous I/O, but the
runtime programs are available on first synchronous access without top-level
await, fire-and-forget races, LSP initialize gating, or test-suite preload hooks.

DOM declarations remain async because they are large and only needed when a
project explicitly requests `compilerOptions.lib: ["dom"]`; that path already
has async entry points (`ensureDomProgram()`) and does not force the Binder or
TypeChecker's core runtime getters to depend on preload ordering.
