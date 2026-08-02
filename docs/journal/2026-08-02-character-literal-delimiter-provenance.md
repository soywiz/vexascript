# Character literal delimiter provenance

## Context

VexaScript changed single-quoted expression literals from strings to integer
Unicode code points while TypeScript parsing retained ordinary single-quoted
string semantics. Multi-code-point single-quoted values became recoverable
parser diagnostics with a shared VS Code/Monaco quick fix.

## Architectural lesson

The tokenizer previously decoded string contents and discarded the delimiter.
That representation was sufficient while single and double quotes were
semantically interchangeable, but it made the language distinction impossible
to implement reliably downstream. Quote provenance now travels once on the
token and the parser chooses the durable AST node from the active language mode.
Type checking and both emitters consume that node instead of inspecting source
text or maintaining parallel quote maps.

## Recovery decision

An early implementation represented an invalid literal such as `'grey'` as the
code point for its first character. That kept an integer-shaped AST but caused
unrelated formatter and emitter paths to silently show `103` behind the parser
error. The final recovery path retains a string-shaped AST for invalid lengths
while still reporting the error. Valid one-code-point literals alone become
`CharacterLiteral`. This keeps editor infrastructure useful until the quick fix
rewrites the source and prevents misleading recovery output.

## Regression risks

- TypeScript parser mode must never reinterpret single-quoted declaration-file
  strings as characters.
- Template-literal text segments and double-quoted strings must not acquire
  character semantics.
- AST traversal, semantic typing, formatting, semantic tokens, JavaScript
  emission, and C++ native-type selection must all recognize the new leaf node.
- Adding a numeric `NodeKind` changes every later discriminator, so the
  serialized program-cache version must be bumped in the same change; otherwise
  an old cached AST can be revived with the wrong constructors.
- Invalid literals must keep an AST so both Monaco and VS Code can offer the
  shared conversion fix.
