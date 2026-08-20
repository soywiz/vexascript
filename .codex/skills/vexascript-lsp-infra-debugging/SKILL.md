---
name: vexascript-lsp-infra-debugging
description: Debug VexaScript problems where the visible symptom is in VS Code, Monaco, LSP hover/go-to-definition/diagnostics/semantic tokens, bundled sample runtime output, or generated JavaScript, especially when the fix requires reproducing the full compiler/LSP/import/session infrastructure instead of only inspecting one source file.
---

# VexaScript LSP Infrastructure Debugging

Use this skill when an editor symptom does not match compiler/runtime behavior, or when a feature works in simple tests but fails in VS Code, Monaco, samples, node_modules declarations, generated bundles, or cross-file imports.

## Core Rule

Reproduce the exact infrastructure path before changing the implementation:

1. Identify the user-visible surface: diagnostics, hover, go-to-definition, semantic tokens, formatting, emitted JavaScript, sample serve output, or browser runtime.
2. Find the LSP/compiler entrypoint for that surface.
3. Build a focused in-process reproduction that calls the same entrypoint with realistic sessions, imports, source roots, and `getSessionForFilePath`.
4. Add a regression test that uses the same path.
5. Only then patch the shared resolver/type/emitter/parser code.
6. Validate with focused tests, full tests, the CLI smoke check, and extension/browser installation when relevant.

## Infrastructure Checklist

For cross-file LSP behavior, do not create a bare `createAnalysisSession(source)` and assume that matches VS Code. VS Code usually has imported declarations and external symbol metadata.

Use this shape:

```ts
const baseSession = createAnalysisSession(source);
const collected = await collectAllImportedDeclarations(baseSession.ast!, {
  uri,
  sourceRoots,
  getSessionForFilePath
});
const session = createAnalysisSession(
  source,
  {
    externalDeclarations: collected.externalDeclarations,
    externalDeclarationLocations: collected.externalDeclarationLocations,
    importedSymbols: collected.importedSymbols,
    invalidImportedBindings: collected.invalidImportedBindings
  }
);
```

Then call the same public resolver the LSP uses, such as:

- `resolveDefinitionAcrossFiles` or `resolveDefinitionWithLocalFallback`
- `resolveHoverWithLocalFallback`
- type diagnostics collection
- semantic-token generation
- completion/signature/inlay helpers

For cursor-sensitive bugs, test multiple positions: inside the token, at token end, and where VS Code actually sends the request. Prefer `sourceWithCursor` for tests, but use explicit line/character probing when reproducing editor token-end behavior.

## Common Failure Pattern

If hover works but go-to-definition fails, avoid assuming type analysis is broken. It often means:

- hover used a type-checker path that already resolved the symbol,
- definition uses a separate navigation path,
- navigation is missing imported declarations, extension members, inherited members, merged declarations, generic defaults, node_modules declarations, or candidate cursor positions.

Debug by comparing:

1. Does `TypeChecker.getExpressionType(...)` know the member?
2. Does the navigation helper find the AST node at the VS Code cursor position?
3. Does cross-file declaration resolution search the same imported declarations that the type checker sees?
4. Does the resolver return a `Location` with the original declaration file/range, not the import line?

## Samples And Runtime

When the visible issue involves `samples/<name>` or `pnpm cli serve`, inspect the generated output too. For bundled samples, confirm both:

- the compiler/LSP diagnostics are clean,
- the emitted `__vexa_bundle__.js` calls the correct lowered runtime form.

For extension members, verify generated code uses the mangled standalone function/property accessor when appropriate, not native member access:

```js
View$$addTo$$Container$any(receiver, stage)
View$$point$set(receiver, value)
```

If the browser still shows an old error after a compiler fix, rebuild/reinstall the extension or restart the dev server before trusting the UI.

## Latency Reproduction

For LSP performance regressions, reproduce with the same workspace/sample wiring before changing caches.

Use the sample-configurable profiler with the same `.vx` loader as the official
test suite:

```bash
node --import tsx --import ./scripts/registerTextModuleLoader.cjs \
  .codex/skills/vexascript-lsp-infra-debugging/scripts/profile_sample_lsp_latency.ts <sample-name> [edit-scenario] [entry-file]
```

Omit `<sample-name>` to profile Pixi. The entry file defaults to `html.vx` and
can be overridden for samples with another editor entrypoint, such as
`hono newline server.vx`. The script builds the current `AnalysisSessionCache`
contract used by `compiler/lsp/server.ts`, opens the selected entry file,
mirrors it into the project index, and measures
the same cold-path ingredients that feed:

- `textDocument/diagnostic`
- `workspace/diagnostic`
- `textDocument/semanticTokens/full`
- `textDocument/semanticTokens/range`

Use the `incomplete-member` edit scenario to insert a standalone `.x` before
the D3 line generator's accessor call. This reproduces the workspace-diagnostic
burst caused by a temporarily invalid member chain instead of profiling only an
appended blank line. Use `extra-argument` with `hono extra-argument server.vx` to
replace `delay(1000)` with `delay(1000, x)`. That scenario captures the
overloaded generic-call work caused by a common transient edit inside a Hono
handler.

Treat the script as the terminal-side reproduction for editor latency. It removes
VS Code transport noise but keeps imported declarations, declaration provenance,
ambient types, DOM libs, and project-index lookups. Before trusting the timings,
verify that document, module, and cross-file diagnostics match the editor and do
not show errors caused by a broken profiler session.

The output separates:

- cold session construction;
- immediate warm deprecated-modifier work;
- concurrent editor-like feature work;
- an edited document version that reuses the external declaration graph;
- project-index session/build counters;
- deprecated-member visits, candidates, resolutions, and declaration-index cache
  hits;
- analysis-session `binding`, `type-checking`, and `total` self spans, without
  queue-inclusive request latency; and
- structural type-comparison calls for cold and edited sessions.

Use the counters as the regression invariant. For example, a document with no
deprecated member use should not perform project session requests merely to
prove that ordinary members are not deprecated. Treat milliseconds only as
observational evidence.

In the live LSP log, `[Timing]` durations must be `self` timings for owned
synchronous work or explicit owned phases. Do not emit queue-inclusive elapsed
durations beside them: single-thread event-loop blocking would attribute one
owner's work to every waiter. Use `⚠️ SLOW` at 250 ms and `🚨 SUPER SLOW` at
750 ms. A `pendingReuses=1` counter identifies a waiter without inventing an
owned duration for it.

Representative findings:

- cold `AnalysisSessionCache.getForDocumentAsync(...)` is a major first-hit cost
- deprecated-member analysis is expensive in both diagnostics and semantic tokens
- `semanticTokens` token building itself is cheap once deprecated modifiers are already available
- workspace diagnostics add some extra member-diagnostic work, but deprecated-member work dominates more often than token emission
- D3 exposed an inverted-search failure: resolving every member access before
  discovering that there were zero deprecated results. Indexing the small set of
  accessible `@deprecated` declarations first reduced the deprecated semantic
  pass to zero project-session requests while retaining overload and inheritance
  checks for genuine candidates.
- An incomplete D3 member chain exposed a second fallback failure:
  `collectCrossFileMemberDiagnostics` searched the project for all member uses,
  including members already resolved by semantic analysis, unknown callback
  receivers, and a chain whose earlier receiver was a function. Rejecting those
  impossible fallback candidates reduced the edited pass to zero project-session
  requests and zero class resolutions.
- Typing `.x` exposed a version-burst failure: completion for the intermediate
  `.` version could synchronously build a session before the `x` change reached
  the event loop. Yield once before expensive completion/semantic-token work,
  reject superseded versions, and assert zero analysis-session requests for the
  stale completion.
- Once queue waiting was separated from self work, D3 still showed roughly 4.1
  million structural type comparisons in one resolved session. Equality
  buckets reduced that to about 93 thousand; structural equality remains the
  final check for candidates inside the same bucket.

If VS Code timings are much worse than the script timings, compare:

1. whether VS Code is triggering multiple surfaces concurrently on the same edit/open burst
2. whether the expensive sub-results are cached across diagnostics and semantic tokens
3. whether the editor is repeatedly forcing `workspace/didChangeConfiguration` or other refresh paths
4. whether the sample has unsaved edits or extra imports that differ from the checked-in `samples/<sample-name>/html.vx`

When chasing latency, measure substeps separately before adding more caches. In this codebase the likely hotspots are:

- imported-declaration collection during cold session creation
- deprecated-member discovery (`collectDeprecatedDiagnostics` / `collectDeprecatedSemanticTokenModifiers`)
- cross-file diagnostics helpers
- expensive code-action producers that only make sense when diagnostics exist

Do not run this profiler through bare `pnpm tsx`: compiler modules import `.vx`
runtime declarations and require `scripts/registerTextModuleLoader.cjs`.

## Validation Sequence

Use the narrowest relevant tests first:

```bash
pnpm test -- compiler/lsp/crossFileNavigation.test.ts compiler/lsp/crossFileTypeDiagnostics.test.ts samples/pixi.test.ts
```

Then run the required project checks before finishing:

```bash
pnpm test
pnpm cli vexa testFixtures/sample.vx
```

For VS Code extension behavior, package/install the extension after tests pass:

```bash
pnpm vscodeext:install
```

Tell the user to reload VS Code or restart the extension host if the editor still shows cached behavior.

## Editing Guidance

Prefer unified resolver paths. If one subsystem already knows how to resolve a symbol, avoid adding a parallel special-case branch unless the existing abstraction cannot represent the case.

Keep fixes near the shared layer:

- parser/tokenizer/AST for syntax shape,
- type checker for semantic knowledge,
- emitter for runtime lowering,
- declaration/import resolvers for cross-file symbol discovery,
- LSP surface helpers only for request-specific cursor/range adaptation.

Do not treat VS Code screenshots as proof of the current source state after a code change. Confirm with an in-process reproduction and reinstall/reload the editor integration.
