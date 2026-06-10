# LSP Services Status

This document tracks common Language Server Protocol services and their status in VexaScript.

## Core Language Features

- [x] `textDocument/completion`
- [x] `textDocument/hover`
- [x] `textDocument/definition`
- [x] `textDocument/references`
- [x] `textDocument/rename`
- [x] `textDocument/prepareRename`
- [x] `textDocument/declaration`
- [x] `textDocument/typeDefinition`
- [x] `textDocument/implementation`
- [x] `textDocument/signatureHelp`
- [x] `textDocument/documentHighlight`
- [x] `textDocument/documentSymbol`
- [x] `workspace/symbol`
- [x] `textDocument/semanticTokens/full`
- [x] `textDocument/semanticTokens/range`
- [x] `textDocument/inlayHint`
- [x] `textDocument/codeLens`
- [x] `textDocument/foldingRange`
- [x] `textDocument/selectionRange`
- [x] `textDocument/linkedEditingRange`
- [x] `textDocument/callHierarchy`

## Diagnostics and Code Actions

- [x] `textDocument/publishDiagnostics` (push model)
- [x] `textDocument/codeAction` (quick fixes)
- [x] `textDocument/codeAction/resolve`
- [x] `workspace/diagnostic` (reports open workspace documents; push diagnostics remain enabled)

## Formatting

- [x] `textDocument/formatting`
- [x] `textDocument/rangeFormatting`
- [x] `textDocument/onTypeFormatting`

## Workspace and Commands

- [x] `workspace/executeCommand`
- [x] `workspace/configuration`
- [x] `workspace/didChangeWatchedFiles` (server-side handling)

## Notes on Implemented Features

- Completion includes in-scope symbols, builtin types, and auto-import suggestions.
- Signature help supports functions and constructor calls (`new Class(...)`).
- Inlay hints provide inferred type hints and parameter name hints (including constructor calls).
- Document symbols include top-level declarations and class members.
- Workspace symbol search scans `.vx` files in source roots.
- Code actions include declaration keyword replacements and auto-import fixes.
- Diagnostics include parser and semantic issues, and keep semantic checks enabled after parser recovery.
- Semantic tokens provide semantic highlighting for keywords, operators, literals, and symbols (`full` + `range`).
- Formatting supports both full-document and selection/range requests.
- Formatting keeps `import { ... } from "..."` statements on a single line (wrapping the named bindings one per line, TypeScript-style, only when the line would be too long), groups consecutive imports together by collapsing blank lines between them, and separates the import group from the rest of the code with a single blank line.

## Recent diagnostic coverage

- Semantic diagnostics include a dedicated code for duplicate switch defaults.
- Semantic tokens classify regular expression literals with string-like token coloring.

## Monaco editor parity (no LSP)

The Monaco browser plugin (`plugins/monaco/src/compiler-providers.ts`) reaches
feature parity with the VS Code extension **without** running an LSP. Instead of
speaking the protocol, it registers Monaco language providers that call the
compiler's `compiler/lsp/*` feature functions directly in-process and maps the
results to Monaco types. The following services are wired this way:

- Completion (with keyword-only fallback), hover (with in-file member hover),
  signature help.
- Definition, declaration, type definition and implementation (all backed by the
  shared cross-file definition resolver).
- References, document highlights, rename (with prepare/reject), linked editing.
- Document symbols, folding ranges, selection ranges, inlay hints, code lenses.
- Semantic tokens (`full` + `range`).
- Quick fixes / code actions via the shared `compiler/lsp/codeActionsAggregate.ts`
  collector (declaration-keyword swaps, function shorthand, string-template,
  auto-import, call fixes, create-member, type fixes, interface implementations).
- Diagnostics (push model via Monaco markers).
- Document, range and on-type formatting.

Not implemented in Monaco because the standalone editor has no public provider
API for them (and the static demo is single-file): call hierarchy and workspace
symbol search. Cross-file features degrade gracefully to in-file results since
the browser has no real file system.

## Recently completed services

- Declaration, type-definition, and implementation requests reuse project-aware definition resolution.
- Document highlights, reference code lenses, folding ranges, nested selection ranges, and linked editing ranges are available.
- On-type formatting handles newline indentation and closing braces.
- Call hierarchy reports same-document function calls.
- Workspace diagnostic pulls report open documents. Configuration and watched-file changes refresh open-document diagnostics and invalidate changed project files.
