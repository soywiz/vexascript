# Smart-cast completion details

Completion member access already used the flow-sensitive expression type for a
value narrowed by `is`, but in-scope symbol completion displayed the original
declaration symbol. For a parameter declared as `any`, this made the editor
show `In-scope parameter: any` inside an `if (value is string)` branch even
though `value.charCodeAt` resolved correctly.

The first suspected layer was the type checker because the visible symptom was
an incorrect type. The focused reproduction showed that identifier resolutions
inside the branch already carried `string`; only `getVisibleSymbolsAt` returned
the lexical symbol with `any`. An initial completion-only fix handled a cursor
inside the complete identifier, but a second reproduction with the partial
prefix `val` exposed that it still fell back to `any`. The durable fix exports
flow-sensitive scope snapshots from the type checker and uses the snapshot that
contains the completion position, while completion still reuses a more recent
identifier resolution when one is available. A completion regression test now
covers the partial-prefix smart-cast case. The VS Code bundle also had to be
rebuilt and reinstalled; the checked-in source change alone does not replace the
running extension host.

The same issue appeared in subject `match` arms. The parser lowers a subject
match into an `if` chain, but expression-bodied arms without braces do not have
their own bound lexical scope. Recording those narrowings against the fallback
function scope made the `else` snapshot overlap the typed arm and overwrite its
completion type. Narrowing snapshots now carry the actual branch statement as
their position node, so adjacent expression-bodied arms remain separate.
