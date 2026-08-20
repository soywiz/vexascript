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
