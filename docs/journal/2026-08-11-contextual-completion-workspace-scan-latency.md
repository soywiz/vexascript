# Contextual completion workspace-scan latency

## Symptom

In `samples/preact/html.vx`, completion inside a typed JSX `style` object took about six seconds. Two consecutive completion requests each paid nearly the same cost. Other VS Code requests appeared to take several seconds as well because the CPU-heavy completion work blocked the LSP event loop.

The exact editor-session profile, with an unknown `test` property added to the style object, measured:

- first completion: 6,069.7 ms;
- second completion: 5,969.8 ms;
- sequential editor-request burst: 12,263.6 ms.

## Investigation

An initial hypothesis blamed eager global auto-import collection because the completion handler resolved all workspace exports before checking exclusive contexts such as JSX attributes and object literals. Making auto-import resolution lazy was still necessary, and a deterministic regression test now verifies that contextual object completion does not request workspace exports.

That change alone did not improve the exact sample. A CPU profile showed the real dominant path in repeated project scans and path normalization. Contextual property-name completion called `collectObjectLiteralValueCandidates` for every available property so it could decide whether accepting the property should trigger another completion request. For the large Preact CSS type, each property could attempt enum and type-alias lookup across the workspace. Hundreds of properties multiplied those scans into seconds of redundant work.

The skill profiler initially failed when invoked through `pnpm tsx` because `.vx` module loading was missing. Running it through Node with both the TSX hook and `scripts/registerTextModuleLoader.cjs` reproduced the real server path.

## Fix

Property-name completion no longer resolves property values eagerly. Accepting any typed object property triggers value completion in the resulting value context. That second request resolves candidates for only the selected property and still derives every candidate exclusively from TypeScript declarations; it does not add CSS tables or heuristic values.

The completion orchestrator also resolves auto-imports only after all exclusive contextual completion strategies decline the request. Contextual object property completion distinguishes `null` (not this context) from an empty array (this context has no candidates), so it cannot accidentally fall through to unrelated global suggestions.

After the fix, the same profile measured:

- first completion: 10.9 ms;
- second completion: 1.97 ms;
- sequential editor-request burst: 235.8 ms.

Cold project analysis remained about 788 ms in this profile. It is a separate one-time project-loading cost rather than the repeated six-second interaction regression.

## Regression protection

The completion tests now assert both that contextual object completion does not request workspace exports and that preparing a typed property's name list performs no workspace directory scans. Value-completion tests continue to cover literal unions, enums, and imported aliases, preserving the type-driven contract.
