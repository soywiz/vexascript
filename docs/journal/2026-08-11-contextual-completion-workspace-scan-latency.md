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

## Follow-up: analysis and open primitive values

A follow-up editor reproduction added `accentColor: ""`. Property-name completion was fast, but the value request waited about 450 ms for a new analysis session, while cross-file diagnostics took about 899 ms in the same edit burst.

A CPU profile found that every document analysis eagerly built fully resolved symbols for every declared JSX intrinsic element. Preact exposes a large HTML tag set, so this resolved the complete props graph for tags that the document never used. Intrinsic tag completion only needs the declared tag names and declaration nodes. The checker now records those lightweight symbols directly and retains full props resolution for JSX tags that actually occur in the program. The exact sample's cold analysis fell from about 832 ms to 315 ms; the remaining cold time includes roughly 157 ms of one-time DOM declaration loading.

The cross-file diagnostic fallback also attempted to resolve the already-known ambient `Document.getElementById` call by scanning every project `.vx` file. Calls with a selected semantic-analysis resolution now bypass that legacy fallback. Cross-file type diagnostics in the exact sample fell from hundreds of milliseconds to 1.45 ms without changing diagnostics for unresolved cross-file calls.

Finally, value completion treated open primitive types such as `string | number | null | undefined` as possible enum or alias names and searched the workspace before returning no finite candidates. Built-in open types now terminate immediately. `accentColor` value completion fell from about 42 ms to 0.89 ms. This remains strictly type-driven: open strings produce no invented color suggestions, while declared literal unions, enums, and imported aliases retain their existing completion paths.

The latency profiler itself still used the removed `importedSymbolTypes` and `importedSymbolDisplayTypes` fields, which made its session differ from the real server and produced false missing-export diagnostics. It now passes the unified `importedSymbols` map used by the production LSP.
