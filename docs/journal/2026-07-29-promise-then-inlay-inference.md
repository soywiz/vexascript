# Promise `then` inlay inference

## Problem

The variable inlay hint for `fetch("").then({ it.text() })` could report a nested
`Promise<Promise<string> | never>` instead of `Promise<string>`.

## Cause

Generic inference treated `Promise<string>` as unrelated to the `PromiseLike<TResult>`
branch in the standard `then` callback contract. It therefore inferred the callback
result as the entire promise instead of its fulfilled value. The display layer also
rendered the semantically empty `| never` branch. Separately, the inlay resolver used
the first token of a member callee, which selected the nested `fetch` call rather than
the outer `then` call.

## Resolution

- Let generic inference match `Promise<T>` against `PromiseLike<T>` while selecting
  and inferring a generic branch.
- Omit `never` from a displayed union that has another reachable member.
- Resolve member-call inlays at the member token, then use the checker result for
  generic return types while retaining declaration spelling for selected overloads.

## Investigation note

The grey `onfulfilled:` in the screenshot is an inlay parameter label, not a named
source argument. Reproducing it as a named argument led to an unrelated contextual-
typing path; the exact source reproduction is `.then({ it.text() })`.
