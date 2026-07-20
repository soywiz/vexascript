# Receiver function contexts use one first-argument model

## Context

Receiver function types, receiver lambdas, the `value. { ... }` shorthand, and labeled receivers were added together for JavaScript and native C++ emission.

## Durable decisions

- A receiver is represented by a marked first `FunctionType` parameter. Structural comparison still compares the complete ordered parameter list, so `A.(B) -> void` and `(A, B) -> void` are compatible without a parallel assignability path.
- The marked receiver parameter is hidden only when displaying and binding the receiver lambda's source parameters. Runtime calls and both emitters receive it as argument zero.
- Receiver-lambda analysis records the resolved receiver type and call label once. JavaScript and C++ emission consume that shared result instead of independently rediscovering context.
- `value. { ... }` is a compiler-intrinsic receiver-in/receiver-out expression. It evaluates the receiver once, executes the block, and returns that receiver without resolving or calling `apply`.
- Generic receiver extensions such as `<T> T.apply` are fallback members. Concrete class, interface, object-literal, boxed, and dynamic members must win before the universal extension is considered.

## Investigation notes

The first implementation correctly parsed the receiver marker but lost it while cloning and instantiating function types. That made contextually typed lambdas infer only their visible parameters and produced misleading assignment errors. Preserving the marker in the existing substitution paths fixed the issue without a second receiver-specific type representation.

Universal extension lookup also initially captured unrelated members named `apply`, including a concrete class method and an object-literal function used by the native smoke. The semantic resolver and both runtime emitters now require the member to have resolved as an extension before considering the universal fallback.

The first shorthand implementation reused an `apply`-shaped call node all the way through semantic analysis and emission. That accidentally made the syntax depend on a runtime `apply` declaration. The call-shaped AST node now carries an explicit shorthand marker: analysis handles it before member lookup, and both backends emit an immediate receiver-returning expression. Regression tests cover a type with no `apply` and a type whose real `apply` method must remain uncalled.

The syntax then appeared broken in a VS Code extension-development window even though parser and in-process LSP sessions accepted the exact source. The root `pnpm code` script rebuilt only the CLI bundle, while the extension host loaded the stale server at `plugins/vscode/dist/vexa.mjs`. The root script now delegates to the extension's canonical `launch` script so the server and client bundles are rebuilt before VS Code opens. Packaging coverage keeps `code` and `vscodeext:launch` on the same command path.

The root install alias had a related command ambiguity: `pnpm --dir plugins/vscode install` invokes pnpm's dependency installer rather than the package's script named `install`. The root `code:*` and `vscodeext:*` wrappers now use explicit `pnpm --dir plugins/vscode run ...` forms, and packaging tests keep both alias families unified.

Implicit receiver members inside the shorthand were type-checked correctly but initially failed Go to Definition. The lambda scope intentionally uses implicit symbols, while cross-file navigation previously discovered receiver types only from extension function/property declarations. Navigation now also selects the narrowest enclosing receiver lambda from the analysis receiver map, then reuses the existing class/interface member resolver. This keeps nested receivers correct and avoids a parallel node-modules lookup path.

The Pixi sample exposed a second divergence hidden by that first fix. Native `Graphics` members such as `circle` were injected with a synthetic lambda node, so navigation stopped at the receiver block instead of continuing to the declaration in `node_modules`. Extensions declared on a supertype, such as `Container.addTo` and `Container.position`, were not injected at all because receiver-block setup checked only the concrete `Graphics` name. The receiver scope now walks the same ordered receiver/supertype list used by ordinary extension lookup, records the declaring extension receiver on the implicit symbol, and lets navigation reuse the existing in-scope extension and node-modules member resolvers. Emitters consume that same declaring-receiver marker, which prevents inherited extensions from being mangled as if they belonged to the concrete subtype.

The same reproduction showed `addTo` as `(other: Container) => unknown` even after navigation was correct. An extension function is deliberately not installed as a normal top-level symbol in its declaring file, so cross-file import collection could not retrieve the return type inferred by the checker. The checked analysis now retains inferred extension method types by receiver and name, and import collection consults that canonical result. A block body with no return therefore remains `void` across the import and receiver-lambda boundary instead of degrading to `unknown`.

Signature help had one final display-only divergence. The structured function type retained the receiver as argument zero, but identifier callees prefer their source-preserving display string; the display-string parser read only the visible `(a: int)` portion of `T.(a: int) -> void`. It now recognizes the receiver prefix and prepends `this: T` to the call signature. This keeps the active parameter aligned with direct calls such as `block(this, 10)` while leaving the receiver hidden in the lambda's source parameter list.

Brace lambdas expose another subtlety: the parser represents their final expression as an implicit return. A receiver block contextually returning `void` must therefore use the existing contextual-void behavior so a final assignment remains valid and native emission produces an expression statement rather than a value return.

## Regression coverage

Focused parser, type, analysis, JavaScript runtime, signature-help, and real Pixi LSP-session tests cover receiver syntax, first-argument compatibility, shorthand blocks, nested labels, concrete-member precedence, inherited extensions, hover types, active call parameters, and Go to Definition into both project files and `node_modules`. The shared native language smoke exercises the same source constructs and inherited-extension lowering through C++ compilation and execution.
