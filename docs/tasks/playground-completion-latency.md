# Playground Completion Latency

## Status

* [ ] Technical debt

## Context

Completion after typing `.` in the browser playground currently shows a noticeable delay even for simple cases such as:

```vx
val current = increment(41)
current.
```

The expectation is that member completion on a recently analyzed local variable should feel close to instant, especially when the receiver type was already known just before typing `.`.

## Current Behavior

The Monaco completion provider in `website/src/assets/vexa-embed.ts` calls `getSessionForModel(...)` for each completion request.

That session cache is keyed by:

* Monaco model `versionId`
* workspace revision

Typing `.` increments the model version immediately, so the cache misses on the exact interaction where low latency matters most.

On a cache miss, the current path does expensive work on the completion critical path:

* load ambient DOM declarations
* build a base `AnalysisSession`
* resolve imported declarations
* resolve imported symbol types
* build another `AnalysisSession` with resolved externals
* run completion logic on top of that session

This means `.` completion is not currently reusing an incremental semantic state. It is recomputing analysis work for the new text version.

## Evidence

Observed profiling for a simple playground completion request shows time in compiler analysis work such as:

* `bind`
* `bindGlobalDeclarations`
* `declare`
* `collectInterfaceStatements`
* `typeToStringInternal`
* `scanTypeText`

That strongly suggests the delay is dominated by recompilation / rebinding / type-processing work rather than Monaco UI rendering.

## Why It Is Slow

### 1. Version-exact session caching is too coarse for typing latency

`modelSessionCache` only reuses a session when the current model version exactly matches the cached one. That helps repeated requests for the same text, but it does not help the most important case: a new completion immediately after a single-character edit.

### 2. The current model can be analyzed twice per miss

`getSessionForModel(...)` builds a base `AnalysisSession`, then may build a second `AnalysisSession` after imported declarations and imported symbol types are resolved.

### 3. Import resolution work is duplicated

The playground path currently gathers imported declarations and imported symbol types separately, even though `compiler/lsp/importedDeclarations.ts` already exposes `collectAllImportedDeclarations(...)` specifically to avoid resolving the same imports twice.

### 4. Completion-local resolver caches are recreated per request

Member completion currently creates a fresh class resolver cache for each request, which prevents reuse of resolved class/interface/member lookup work across nearby completion calls.

## Desired End State

Typing `.` after an already analyzed expression should feel instant or very close to instant in the playground.

That does not require every language feature to become fully incremental immediately, but it does require the completion path to avoid rebuilding more semantic state than necessary for single-character edits.

## Suggested Plan

* [ ] Replace separate imported-declaration and imported-symbol collection in the playground session path with `collectAllImportedDeclarations(...)`.
* [ ] Avoid building a full base `AnalysisSession` when only a parsed AST is needed to inspect imports before the final analyzed session is created.
* [ ] Reuse more completion-time resolver state across requests for the same model and workspace revision instead of recreating caches per request.
* [ ] Introduce a warmer per-model analysis lifecycle that can reuse the previous completed session for adjacent edits such as typing `.`.
* [ ] Measure completion latency before and after each step so the real hotspot reductions are visible.

## Notes

This task is primarily about responsiveness, not correctness. The current behavior appears functionally correct, but the completion architecture still behaves like a cold semantic request on a hot keystroke path.
