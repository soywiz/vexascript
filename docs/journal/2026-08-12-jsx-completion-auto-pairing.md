# JSX completion must consume editor auto-pairs

## Symptom

VS Code inserts the closing `}` when the user types `{` in JSX. The JSX
control-flow completion snippet also inserts its own header-closing `}`, so
accepting `{#for}` left an extra brace at the end of the generated block.

## Investigation

The completion provider already generated the correct block snippet. The
problem was the LSP edit range: it replaced only the text before the cursor,
leaving the auto-inserted brace immediately after the cursor untouched.
Testing the completion item through the shared LSP server reproduced the same
range, confirming this was not a VS Code-only rendering issue.

An empty JSX tag probe (`< />`) also showed that the parser can return no AST
while a tag name is still being typed. A hardcoded list of HTML tags would have
made that case appear to work, but would violate the editor's type-driven
completion contract and would diverge from framework declarations. The valid
JSX completion path already obtains intrinsic names from the resolved
`IntrinsicElements` declaration, so the regression coverage keeps that source
of truth and makes its replacement range explicit.

## Resolution

JSX block completion now extends its replacement range by one character when a
`}` is immediately under the cursor. The snippet replaces the editor's pair
with the generated closing brace, while normal completion without an existing
brace keeps the original range.

Intrinsic JSX tag and component completions now return explicit text edits that
replace only the typed tag prefix. This makes accepting `div`, `h1`, or a
component after `<` deterministic across LSP clients without inventing a
framework-specific tag catalog.

## Follow-up regression

The first implementation worked for a valid JSX AST but not while the user
was still typing the opening name. At `<di`, the parser intentionally returns
no AST, so the LSP's null-AST fallback returned only keyword completions. The
completion provider also did not advertise `<` as a trigger character, which
prevented automatic requests from starting at the opening angle bracket.

The LSP now recovers an incomplete opening tag as a temporary self-closing tag
when loading imported declarations and reuses that session only for completion.
The original document remains responsible for diagnostics. `<` is registered
as a completion trigger in the LSP and Monaco providers so typing a tag starts
the same type-driven completion flow automatically.

## JSX tag closing while typing

The same incomplete-document problem appears immediately after typing an
opening tag's `>`: without an automatic closing edit, the document temporarily
contains an unbalanced JSX tree and diagnostics can cascade while the user is
still typing. The shared on-type formatting path now inserts the matching
`</Tag>` for real opening tags and registers `>` as a trigger in both the LSP
server and Monaco worker.

The edit deliberately leaves self-closing tags, closing tags, existing closing
tags, strings, comments, and spaced comparison expressions untouched. This
keeps recovery/editor assistance focused on JSX instead of masking ordinary
source text.

## Editor integration follow-up

The shared on-type handler was correct in isolation, but VS Code does not
request `textDocument/onTypeFormatting` when `editor.formatOnType` is disabled.
The extension now calls that same handler as a narrow fallback only for a
single inserted `>` when the setting is disabled, preserving the editor
selection after the insertion. This keeps binary `>` expressions unaffected
because the shared JSX-context check still returns no edit.

Closing-tag completion is also independent of a valid AST: after `</`, the
completion path scans the pending JSX opening-tag stack and offers the nearest
matching name, including when the document is temporarily parser-incomplete.

The VS Code fallback also needs the editor's current text explicitly. Asking
the standard LSP on-type method immediately from a document-change listener
can race the language client's document synchronization, so the adapter now
uses a small shared-server request that receives the current text. The change
detector accepts multi-character insertions such as a completion edit, but
ignores the `</...>` edit that it inserts itself; otherwise the fallback would
re-enter recursively and append repeated closing tags.

A second failure only appeared in a larger real file. The duplicate-closing
guard originally searched the entire suffix for a matching closing tag. Typing
`<div>` in one component was therefore suppressed when a different component
later in the file happened to contain `</div>`. Small single-expression tests
could not expose this. The guard now follows nested JSX tags and stops at the
first unmatched closing tag, which bounds the lookup to the current JSX tree.
Regression tests should include a later unrelated component reusing the same
intrinsic tag name, not only an isolated opening tag.
