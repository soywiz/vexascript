# Portable template-string highlighting

The homepage rendered template strings as ordinary code even though the VexaScript parser, emitter, LSP quick fixes, and VS Code TextMate grammar already supported template interpolation and `$name` shorthand. The visible failure came from a split syntax surface: the portable Monarch language used by the website's server-side highlighter and Monaco generation had no backtick or template-expression states, so it tokenized the contents as identifiers and operators.

The useful dead end was checking compiler support first. That path was already complete, including focused tokenizer, transpiler, LSP, and documentation coverage; changing the parser would have duplicated an existing feature. The durable fix was to add template-string, shorthand-interpolation, and nested braced-expression states to the shared portable grammar, then cover the rendered HTML behavior directly.
