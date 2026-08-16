# JSX ancestor-closing recovery

## Symptom

Temporarily omitting a nested JSX closing tag changed syntax colors across the
rest of a large file. For example, in `<button><div></button>`, declarations
after the component lost semantic classifications even though `</button>`
clearly bounded the outer JSX tree.

## Root cause

The JSX tokenizer treated any closing tag as the end of the current nested
element without comparing names. It therefore consumed `</button>` as though it
closed `<div>`, kept the outer `<button>` open, and interpreted later source as
JSX children until tokenization eventually failed. Semantic-token generation
catches tokenization failures and returns no semantic tokens, producing the
large color shift seen in the editor.

An initial semantic-token fallback would have hidden only the coloring symptom.
The same lost boundary also affected parsing and diagnostics, so recovery had
to live in the shared tokenizer and parser instead.

## Recovery rule

The tokenizer tracks open JSX tag names. When a closing tag matches an ancestor
rather than the current element, the current element ends implicitly without
consuming that closing tag. The ancestor then consumes its own close normally.
The parser mirrors the stack, preserves the recovered AST, and reports the
missing nested close at the nested opening tag, such as:

```text
JSX element <div> is missing closing tag </div>
```

This keeps later diagnostics and semantic tokens stable while the user is in a
temporarily incomplete editor state. Regression coverage must span tokenizer
boundaries, parser diagnostics, semantic tokens after the error, and the real
editor integration.
