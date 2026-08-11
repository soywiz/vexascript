# Canonical syntax aliases must cover parser defaults and editor generation

Adding `fn` and `func` initially looked like a parser-keyword-list change plus
new normalization quick fixes. The same spelling preference also existed in
less obvious generation paths: keyword-less class methods, readonly-field
conversion, interface implementation stubs, syntax highlighters, completion
context recovery, and the Node LSP project environment. Keeping the accepted
aliases and canonical preferences in one shared model prevents those surfaces
from choosing different spellings.

The first investigation pass treated “default `const` instead of `val`” only as
an editor preference. That was incomplete. Primary-constructor parameters with
no explicit declaration keyword were parsed with a synthetic `val` kind, and
the AST formatter could expose it. The parser default therefore also had to
change to `const`, independently of configurable editor normalization.

The first full-suite run also exposed a test that named a local function value
`fn`. Once `fn` became a declaration keyword, a statement beginning with
`fn = ...` was correctly routed as a function declaration instead of an
assignment. The type-assignability test was not testing keyword behavior, so
renaming that local to `callback` restored its intended coverage. Future alias
additions should search for identifiers that become ambiguous at statement
boundaries, not only parser keyword tables.

The durable boundary is:

- the parser accepts every alias regardless of project preferences;
- omitted primary-constructor declaration kinds use the language default
  `const`;
- `vexascript.json.canonicalSyntax` selects spellings for normalization and
  editor-generated source without changing semantics;
- the syntax tour keeps canonical examples while retaining explicit legacy and
  short aliases as regression coverage.
