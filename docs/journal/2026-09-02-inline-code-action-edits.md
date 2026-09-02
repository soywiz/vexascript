# Inline code-action edits

## Problem

The LSP deferred every workspace edit to `textDocument/codeAction/resolve`.
VS Code could display those unresolved quick fixes but, in practice, selecting
one did not always apply its edit until the action was requested a second time.

## Change

Code actions now carry their workspace edits in the initial
`textDocument/codeAction` response, and the server advertises
`resolveProvider: false`. Existing collection and caching remain unchanged, so
this removes a fragile client round trip without increasing compiler work.

## Regression risk

New code-action producers must keep edits serializable and valid in the initial
response. A server-level regression requests the `Add 'func' keyword` action
once and requires an immediately applicable edit.

## Execution metadata

- Date: 2026-09-02
- Provider: OpenAI
- Model: Unavailable (not exposed by runtime)
