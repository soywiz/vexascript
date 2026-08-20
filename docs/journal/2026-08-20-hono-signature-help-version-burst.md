# Hono IDE overloaded-call and version-burst latency

## Symptom

Editing `samples/hono/server.vx` in a VS Code extension host repeatedly left
language features unavailable for about six seconds. The first timing capture
assigned the work to `textDocument/signatureHelp`. After that request was moved
off its synchronous path, a real editor edit (`delay(1000, x)`) exposed the
underlying owner: `textDocument/completion` spent 6.3 seconds building the
resolved analysis session.

This was not queue-inclusive timing noise or dependency resolution. The same
edit in the package-backed profiler took 7.4 seconds inside resolved
type-checking while reporting one external-cache hit, zero external resolver
runs, and zero base builds.

## Causes and fixes

Completion already yielded one browser-compatible event-loop turn before
starting semantic work, checked whether the captured document version was still
current, and used the asynchronous analysis-session path. Signature help had
remained on the older synchronous `getForDocument` path, so it could block the
event loop before a newer change notification invalidated the request.

Signature help now uses the same version gate and asynchronous session helper as
completion. A superseded request returns `null` and logs
`staleVersionSkips=1 analysisSessionRequests=0`; a current request still returns
the normal type-driven signature through the canonical analysis-session cache.

The deterministic regression captures two document versions without awaiting
the intermediate request. Before the fix, the superseded signature request
reported one synchronous request, one cache miss, and one base-session build.
After the fix, every analysis-session counter remains zero. Separate coverage
verifies that a current request returns `greet(name: string): string` through
one asynchronous request.

The remaining type-checking cost had two related causes in generic overload
processing:

1. The substituted-type cache rendered every substitution value to a full type
   string. Hono's conditional and mapped types made those cache keys enormous.
   The checker already maintains stable analysis-type identities, so the cache
   now uses those identities instead of serializing whole type graphs.
2. Callable overload arity treated every tuple rest parameter as unbounded.
   Hono represents handler-count overloads as fixed tuples such as
   `...handlers: [H, H, H]`; a two-argument route call therefore scored all of
   them whenever an unrelated transient error prevented an early perfect
   match. Arity filtering now uses fixed tuple lengths, trailing optional tuple
   members, and a conservative array tail for variadic tuples.

The isolated regression uses an overloaded generic router declaration with
increasing fixed handler tuples and an invalid call inside its callback. It
asserts a deterministic type-render work bound instead of a wall-clock limit.
Separate coverage verifies that one- and two-handler fixed tuple overloads keep
their distinct result types.

## Real sample evidence

The maintained profiler now has an `extra-argument` scenario and reports both
structural comparison calls and type-render work. On this machine, the exact
Hono edit changed as follows:

| State | Resolved type-check | Type comparisons | Type-render work |
| --- | ---: | ---: | ---: |
| Before either generic fix | 7.38 s | 387,329 | 28,563,040 |
| Identity cache key only | 2.89 s | 208,069 | 3,287,287 |
| Identity key plus tuple-rest arity | 528 ms | 141,365 | 535,393 |

The valid cold resolved type-check in the final run was 587 ms, so the transient
invalid edit is no longer a multi-second outlier. The final edit still performed
one asynchronous session request, one resolved-session build, one external-cache
hit, zero external resolver runs, and zero base builds. Wall-clock values remain
diagnostic; the automated regressions use work counters and exact cache metrics.

## Investigation dead ends and infrastructure repair

The first maintained sample profile failed because it hardcoded `html.vx`, while
Hono's editor entrypoint is `server.vx`. The profiler now accepts an optional
entry filename instead of adding a Hono-specific branch. The open-latency
profiler initially used the repository root, which produced non-representative
diagnostics because the screenshot had opened `samples/hono` as the workspace.
It now accepts an optional workspace root so the terminal reproduction can match
the editor layout exactly.

Profiling Hono from the repository root looked faster but was invalid evidence:
it reported missing-module and cross-file diagnostics. Performance measurements
must not be trusted until the profiler's project root, entrypoint, and diagnostics
match the editor session.

Fixing only signature help was also insufficient. It changed which request owned
the expensive session, allowing completion to reveal the same underlying
type-checking cost. A scoped loose-type-name cache was explored after the first
generic fix, but it did not change Hono's counters or elapsed time and was
reverted. CPU samples instead showed that overload selection remained the next
owner, leading to the tuple-rest arity fix.

## Follow-up: keep ordinary typing off the resolved path

A second editor capture after the first fix showed that typing `del` on a new
line still triggered resolved sessions for `signatureHelp` on consecutive
document versions. Each build took roughly 430 ms even though the cursor was not
inside a call, so signature help could only return `null`. The handler now parses
the current source and rejects positions without a syntactic invocation before
requesting any semantic session. The server regression asserts exact zero
analysis-session requests and builds for this case.

Ordinary identifier completion now has a similarly bounded local path. For a
prefix of at least one character, a browser-compatible local analysis is used
first. When it finds a typed in-scope match, such as the sample's `delay`
function for `del`, those type-driven completions are returned immediately and
the resolved-session cache is not touched. Member, contextual, imported, and
otherwise unresolved completion contexts continue through the canonical
resolved path. The foreground `del` completion and out-of-call signature-help
regressions each require zero resolved-session builds, so those requests no
longer wait for the background build.

## Follow-up: coalesce a typing burst into one semantic build

The local completion fast path initially required two prefix characters. That
still made the first `d` request take the resolved path even though the local
`delay` declaration was already sufficient. The path now accepts a one-character
prefix when it finds a typed in-scope declaration. Regressions require `d`,
out-of-call signature help, and the editor's syntax-only refresh requests to
leave every analysis-session counter at zero.

Document diagnostics are the owner of the remaining semantic build. They now
wait for 500 ms of document stability and follow newer versions before starting
work. A `d` -> `de` -> `del` burst therefore produces one analysis for the final
version rather than one analysis per intermediate version. Exact source text is
also part of completed and in-flight session reuse, so a no-op version bump
shares the already completed or pending semantic result.

Several automatic editor refreshes had been accidental semantic-build entry
points. Document symbols, folding ranges, selection ranges, call hierarchy, and
provisional semantic tokens now use the current parse directly. Inlay hints,
code lenses, linked editing, decorations, highlights, and code actions consume
an already-current semantic session but do not create one. The diagnostic path
remains the single owner that publishes the resolved state after the idle
window.

A real VS Code run exposed a less obvious false positive: the parser represents
VexaScript trailing callback blocks as callable arguments of the outer Hono
route invocation. Signature help therefore considered a cursor anywhere in the
callback body to be inside `app.get(...)`, even on a standalone `del` line.
Syntactic invocation detection now excludes positions inside callable argument
bodies while retaining nested-call signature help. This finding would not have
been visible from the isolated non-call regression alone; the final regression
uses the actual trailing-callback shape.

The final extension-host validation typed a newline plus `del` as four document
changes in the real Hono callback. Every change notification completed in
3.62-10.9 ms. Completion completed in 0.10 ms, reported
`localIdentifierFastPaths=1 analysisSessionRequests=0`, and displayed `delay`.
Signature help returned in 0.02-0.06 ms without requesting a session. The burst
produced one resolved diagnostic build (501.5 ms) after the idle boundary;
subsequent document diagnostics reused it in 0.01 ms rather than starting their
own builds. Code actions and provisional semantic tokens also stayed off the
resolved path while the final build was pending.

Two additional background type-check optimizations were explored: identifier
scanning instead of regular-expression substitution and identity caching of
rendered type graphs. They reduced the isolated resolved build, but the native
self-host compiler then failed while reading its first import. Replacing the
`WeakMap` with an object-local generation cache did not change that failure, so
both speculative optimizations and their tests were removed. Keeping them would
have mixed an editor-latency fix with a separate native compatibility problem;
the durable editor win comes from eliminating and coalescing foreground builds.

## Follow-up: refresh auto-await gutters from the shared session

Moving auto-await decoration requests onto `peekForDocument` removed another
foreground semantic build, but initially introduced a UI regression. The first
request after an edit returned an empty array while the idle diagnostic analysis
was still pending. VS Code interpreted that as an authoritative empty result,
cleared the gutter icons, and never requested them again when the shared session
became available.

A cache miss now returns `null`, distinct from a valid empty decoration list, so
the extension preserves its tracked decorations during the short stale window.
Completing the shared analysis session emits a URI- and version-specific
`vexa/autoAwaitDecorations/refresh` notification. The extension then requests
the decorations again from the completed cache and ignores responses from
superseded document versions. This keeps diagnostics as the single owner of the
heavy work while letting the gutter consume its result.

The regression verifies that the provisional decoration request performs zero
base builds, the diagnostic pull performs exactly one, and the refreshed request
reuses it. A client-side state test distinguishes unavailable (`null`), valid
empty (`[]`), and stale-version responses. In the real Hono extension host,
typing `del` kept both existing gutter icons visible; the provisional custom
request completed in 0.05 ms and the temporary edit was undone afterward.

The first full-suite run failed across package-backed samples because an older
fake LSP connection omitted `sendNotification`. Its synchronous `TypeError`
escaped from the session-update observer into the asynchronous resolution
catch, which then returned the unresolved base session and made every imported
symbol appear missing. A clean-tree comparison passed, isolating the failure to
the new notification side effect. Notification delivery is now optional and a
rejected delivery cannot affect the semantic result; the isolated all-samples
LSP suite returned to 46/46 passing.
