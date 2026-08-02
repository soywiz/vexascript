# Language-aware template tokenization

## Context

VexaScript gained Kotlin-style `$name` shorthand inside template strings while TypeScript retained its standard `${name}`-only behavior. Template strings are lowered by the tokenizer into the same concatenation token stream used by braced interpolation, which keeps parsing, analysis, emission, semantic tokens, and completion on one path.

## Boundary discovered

The tokenizer is also used directly by the Node-module bundler to inspect JavaScript and TypeScript dependency source. Leaving those calls on the tokenizer's VexaScript default would reinterpret literal `$name` text inside third-party template strings. These source-inspection calls must explicitly select TypeScript tokenization even though they do not build a full parser session.

The main parse pipeline now passes its parser language into tokenization. Any future direct tokenizer consumer must likewise decide whether its input is VexaScript or JavaScript/TypeScript instead of assuming that syntax differences only matter in the parser.

## Editor behavior

Completion already derived visible symbols from the normalized interpolation expression, including while a shorthand prefix is partially typed. The remaining editor integration requirement was to advertise `$` as a completion trigger in both the LSP server and the Monaco provider. Focused tests cover completion after both `$` and `$m` inside a class method.

Because braced and shorthand interpolations lower to the same concatenation AST, the brace-toggle quick fixes must recover their edit ranges from the original source text. Keeping this in the existing string-template quick-fix provider avoids a second syntax-specific action path. Only direct identifier segments are eligible; compound expressions such as `${user.name}` remain braced.

## Playground regression discovered

The playground exposed an unrelated `Illegal invocation` failure in its default DOM sample. Auto-await rebuilt every union type even when none of its members were awaitable. For an overloaded DOM method, the rebuilt union compared as changed, so the emitter produced `(await document.querySelector)("#app")` and detached the native method from `document`.

The fix preserves the original union when awaiting does not change any member. A regression test uses the bundled DOM declarations, because a small handwritten overload did not reproduce the exact merged declaration shape that triggered the browser failure. This is an important testing boundary: browser-host typing bugs should be covered against the declarations the playground actually loads.
