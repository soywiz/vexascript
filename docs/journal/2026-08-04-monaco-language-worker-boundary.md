# Monaco language work must stay behind the worker boundary

## Symptom

The website already created a VexaScript language worker, but typing could still
trigger compiler work on the browser UI thread. The visible result was input
latency during editor refreshes even though diagnostics and most providers
appeared to be worker-backed.

## Root cause

The worker migration retained the complete in-process Monaco provider path as a
fallback. A content-change listener also eagerly called the main-thread session
builder, and diagnostics waited for main-thread runtime declaration parsing
before contacting the worker. Formatting was still entirely synchronous.

The request API introduced a second accidental fallback: it represented both a
valid worker result of `null` and an unavailable worker as `null`. Hover,
signature help, linked editing, and other features therefore repeated analysis
on the UI thread whenever the correct result was simply "nothing here."

## Resolution

Monaco providers now have one compiler path: the dedicated VexaScript language
worker. The main thread only snapshots editor/workspace state, converts returned
LSP-shaped values to Monaco values, and updates the UI. Document, range, and
on-type formatting use the same worker boundary. If the worker is unavailable,
language features return an empty result instead of freezing the editor with a
hidden in-process retry.

The worker client uses a discriminated result so successful `null` values remain
successful. Diagnostics also capture the model version and discard stale worker
responses, matching the existing freshness guard for await glyph decorations.

## Validation and reusable lesson

The production website build loaded both `editor.worker.js` and
`vexa-language.worker.js` in a real browser. Typing produced no browser console
errors and the event-loop probe observed no compiler-length stall. The key
architectural lesson is that creating a worker is insufficient if editor event
listeners still prewarm sessions, parse shared declarations, or preserve a
parallel in-process fallback. A worker migration is complete only when the UI
thread has no editor-triggered compiler path.
