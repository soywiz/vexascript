# LSP Services Status

This document tracks common Language Server Protocol services and their status in MyLang.

## Core Language Features

- [x] `textDocument/completion`
- [x] `textDocument/hover`
- [x] `textDocument/definition`
- [x] `textDocument/references`
- [x] `textDocument/rename`
- [x] `textDocument/prepareRename`
- [ ] `textDocument/declaration`
- [ ] `textDocument/typeDefinition`
- [ ] `textDocument/implementation`
- [ ] `textDocument/signatureHelp`
- [ ] `textDocument/documentHighlight`
- [ ] `textDocument/documentSymbol`
- [ ] `workspace/symbol`
- [ ] `textDocument/semanticTokens/full`
- [ ] `textDocument/semanticTokens/range`
- [ ] `textDocument/inlayHint`
- [ ] `textDocument/codeLens`
- [ ] `textDocument/foldingRange`
- [ ] `textDocument/selectionRange`
- [ ] `textDocument/linkedEditingRange`
- [ ] `textDocument/callHierarchy`

## Diagnostics and Code Actions

- [x] `textDocument/publishDiagnostics` (push model)
- [x] `textDocument/codeAction` (quick fixes)
- [ ] `textDocument/codeAction/resolve`
- [ ] `workspace/diagnostic`

## Formatting

- [x] `textDocument/formatting`
- [ ] `textDocument/rangeFormatting`
- [ ] `textDocument/onTypeFormatting`

## Workspace and Commands

- [ ] `workspace/executeCommand`
- [ ] `workspace/configuration`
- [ ] `workspace/didChangeWatchedFiles` (server-side handling)

## Notes on Implemented Features

- Completion includes in-scope symbols, builtin types, and auto-import suggestions.
- Code actions include declaration keyword replacements and auto-import fixes.
- Diagnostics include parser and semantic issues, and keep semantic checks enabled after parser recovery.
