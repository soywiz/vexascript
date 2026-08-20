# D3 completion declaration provenance

## Symptom

In the real `samples/d3` VS Code workspace, typing another continuation member
after the bar selection chain produced global DOM and ECMAScript suggestions
instead of D3 `Selection` members. In particular, `.attr` did not offer the
lowercase D3 method while the unrelated DOM `Attr` constructor appeared.

Typing `docu` in both D3 and Pixi also appeared not to offer the lowercase DOM
global `document`. The server did return it, but VS Code displayed fuzzy
ECMAScript matches such as `decodeURI` first and left `document` far down the
list. Rebuilding through `pnpm code` did not change that behavior; the report
was not caused by a stale extension bundle.

## Root cause

Member-completion recovery was working. Replacing the incomplete continuation
member with `__vexa_completion__` produced a valid analyzed chain and recovered
this receiver type:

```text
Selection<Element | EnterElement | Document | Window | null | SVGRectElement,
  { month: string, value: number }, SVGGElement,
  { month: string, value: number }>
```

The divergence happened afterward. The class/interface resolver received only
the rendered type name and searched the workspace/runtime for an interface
named `Selection`. It selected the DOM `Selection` from `dom.d.ts`, whose 25
members do not include D3's `attr`, before considering the imported D3
declaration. The session had already selectively collected the correct D3
`Selection` declarations and their source locations for the type checker, but
completion did not forward that data into the shared resolver.

The local identifier fast path added during the Hono latency work was a useful
hypothesis but was not the failing branch. The D3 member request reached the
canonical resolved session; it then chose the wrong same-named interface. The
investigation nevertheless showed that the parallel source-only completion
path could hide imported or ambient candidates when any local symbol shared a
prefix, so that shortcut was deleted and all completions now use the canonical
cached session.

The global completion failure had a separate cause. Visible symbols used their
position in the declaration collection as `scopeDistance`, and that value was
encoded ahead of any match quality in `sortText`. `decodeURI` therefore had
sort key `1-0-0065-...`, while `document` had `1-0-1519-...`. VS Code honored
that server ordering even after the user had typed the exact lowercase prefix.
The source-level assertion that the result merely contained `document` missed
the user-visible ranking failure.

## Fix

Completion now forwards the analysis session's external declarations and
declaration locations through `CompletionRequestOptions` into
`ClassResolverOptions`. Interface resolution prefers a local declaration, then
the session's selectively collected imported declarations, and only then the
broader runtime/project fallback. This aligns completion with the type
checker's import graph and prevents an unrelated ambient same-name interface
from winning.

Visible-symbol ranking now receives the identifier prefix already shared by
auto-import completion. Exact case-sensitive prefix matches sort first,
case-insensitive prefix matches follow, and unrelated fuzzy matches remain
last. With `docu`, lowercase `document` now sorts before `Document` and far
before `decodeURI`, without changing empty-prefix scope and expected-type
ranking.

The regression test opens the actual D3 entrypoint with its project config,
DOM declarations, `node_modules` typings, project index, analysis-session
cache, and public LSP completion handler. It checks that `document` sorts ahead
of the previously visible fuzzy match and that the multiline D3 `.attr`
continuation resolves. Pixi has the same global-ranking regression because it
was the second real workspace that exposed the issue.

## Validation

The focused D3, Pixi, completion-engine, and LSP server suites pass. A probe
against the freshly bundled `plugins/vscode/dist/vexa.mjs` process, using real
JSON-RPC `didOpen` and completion requests, returned D3 `attr` after the `.`
trigger and ranked lowercase `document` first in both D3 and Pixi. This
packaged-server probe closes the gap left by the initial source-only test.
