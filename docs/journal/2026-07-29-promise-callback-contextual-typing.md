# Promise callback contextual typing lost generic receiver types

The LSP reported the parameter in
`fetch(url).then(it => it.text())` as `unknown`, even though assigning `fetch`
to a `Response` inside a sync function correctly exposed `Response.text()`.
An in-process LSP session with the real DOM declarations reproduced the editor
behavior, which ruled out stale extension state and DOM member resolution.

The first suspected path was class/interface generic substitution. That path
already substituted `Promise<Response>` into the `Promise<T>` member map
correctly. The loss happened one level deeper: the optional `then` callback is
a union containing a parenthesized function type. The type-name resolver
classified that whole union as a malformed function before splitting it, and
the nested function resolver did not retain the surrounding `T` and method
type-parameter scope.

After preserving those parameters, a second issue became visible. The first
generic-call inference pass applied `then`'s `TResult1 = T` default before
contextually checking the callback. That incorrectly expected the callback to
return `Response | PromiseLike<Response>` and rejected `it.text()`'s
`Promise<string>`. Generic defaults must therefore be deferred during the
contextual first pass and applied only after callback inference.

The regression test uses the real DOM declarations and the LSP analysis
session. It verifies both a clean semantic result and a `Response` hover for
the callback parameter, covering the complete path that originally failed.

The parenthesized brace form, `then({ it.text() })`, exposed a separate parser
edge. Call-argument lookahead recognized explicit `value -> ...` lambdas and
the ambiguous shorthand `{ it }`, but not an implicit-`it` member expression.
It therefore produced a zero-argument brace function and later reported `it`
as undefined. Call arguments that start with `it` and are not an `it: ...`
object property now take the existing implicit-parameter lambda path. Parser
and LSP tests cover this form alongside the explicit arrow form.
