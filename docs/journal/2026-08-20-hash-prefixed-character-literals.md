# Hash-prefixed character literals

## Context

VexaScript originally made single-quoted literals numeric character code points.
That diverged from TypeScript in a common, surprising construct and prevented
ordinary single-quoted strings in `.vx` source. Character intent now uses an
explicit `#` before either quote style, such as `#'\n'` or `#"A"`.

## Architectural lesson

Quote style and literal meaning are independent. The tokenizer now produces a
distinct character token while retaining quote provenance for formatting, and
every downstream surface consumes the same `CharacterLiteral` AST node. The
distinct token also prevents a prefixed character from being accepted silently
where grammar requires a string, such as an import path. Type checking,
JavaScript emission, and C++ emission therefore remain unified and do not need
source-text checks or parallel character representations.

The prefix must be recognized in every lexer state that accepts expressions,
including template interpolation. Syntax highlighters also need the prefixed
form before their ordinary string rules so the complete source range is colored
as a number rather than leaving `#` unclassified.

## Recovery and compatibility

Invalid prefixed values keep a string-shaped recovery AST and produce a
diagnostic; the existing quick fix converts the decoded value to a safe string.
TypeScript tokenizer mode deliberately leaves `#` separate, so VexaScript syntax
cannot become an accepted string accidentally in `.ts`, `.tsx`, or `.d.ts`.

## Validation note

A first focused test invocation omitted the repository's text-module loader and
failed while importing `.vx` declarations. Focused compiler tests that touch the
runtime must include `--import ./scripts/registerTextModuleLoader.cjs`, matching
the canonical `pnpm test` command.

The first native self-host attempt also rejected destructuring assignment into
predeclared lexer locals: the C++ emitter treated the destructuring target as a
temporary record. Reading the helper result into one local and then assigning
its fields directly is simpler and portable across the TypeScript, bundled
JavaScript, and native C++ compiler hosts.
