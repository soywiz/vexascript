# LSP Services

This document describes the current Language Server Protocol feature surface in VexaScript and the main implementation notes behind it.

## Core Language Features

The following core editor/navigation services are implemented:

- `textDocument/completion`
- `textDocument/hover`
- `textDocument/definition`
- `textDocument/references`
- `textDocument/rename`
- `textDocument/prepareRename`
- `textDocument/declaration`
- `textDocument/typeDefinition`
- `textDocument/implementation`
- `textDocument/signatureHelp`
- `textDocument/documentHighlight`
- `textDocument/documentSymbol`
- `workspace/symbol`
- `textDocument/semanticTokens/full`
- `textDocument/semanticTokens/range`
- `textDocument/inlayHint`
- `textDocument/codeLens`
- `textDocument/foldingRange`
- `textDocument/selectionRange`
- `textDocument/linkedEditingRange`
- `textDocument/callHierarchy`

## Diagnostics And Code Actions

The following diagnostic and code-action services are implemented:

- `textDocument/publishDiagnostics` (push model)
- `textDocument/codeAction` (quick fixes)
- `textDocument/codeAction/resolve`
- `workspace/diagnostic` (reports open workspace documents; push diagnostics remain enabled)

## Formatting

The following formatting services are implemented:

- `textDocument/formatting`
- `textDocument/rangeFormatting`
- `textDocument/onTypeFormatting`

## Workspace And Commands

The following workspace-level services are implemented:

- `workspace/executeCommand`
- `workspace/configuration`
- `workspace/didChangeWatchedFiles` (server-side handling)

## Feature Notes

- Completion includes in-scope symbols, builtin types, and auto-import suggestions.
- Signature help supports functions and constructor calls (`new Class(...)`).
- Inlay hints provide inferred type hints and parameter name hints, including constructor calls.
- Document symbols include top-level declarations and class members.
- Workspace symbol search scans `.vx` files in source roots.
- Code actions include declaration-keyword replacements and auto-import fixes.
- Diagnostics include parser and semantic issues, and keep semantic checks enabled after parser recovery.
- Semantic tokens provide semantic highlighting for keywords, operators, literals, and symbols (`full` + `range`).
- Formatting supports both full-document and selection/range requests.
- Formatting keeps `import { ... } from "..."` statements on a single line, wrapping named bindings one per line only when the line would be too long, groups consecutive imports together, and separates the import group from the rest of the code with a single blank line.

## Additional Coverage Notes

- Semantic diagnostics include a dedicated code for duplicate switch defaults.
- Semantic tokens classify regular expression literals with string-like token coloring.
- Declaration, type-definition, and implementation requests reuse project-aware definition resolution.
- Document highlights, reference code lenses, folding ranges, nested selection ranges, and linked editing ranges are available.
- On-type formatting handles newline indentation and closing braces.
- Call hierarchy reports same-document function calls.
- Workspace diagnostic pulls report open documents. Configuration and watched-file changes refresh open-document diagnostics and invalidate changed project files.

## Monaco Editor Parity

The website's Monaco embeds (`website/src/assets/vexa-embed.ts`, with the supporting modules in `website/src/assets/monaco/`) reach feature parity with the VS Code extension without running an LSP server. Instead of speaking the protocol, they register Monaco language providers that call the compiler's `compiler/lsp/*` feature functions directly in-process and map the results to Monaco types.

The following services are wired this way:

- Completion, with keyword-only fallback
- Hover, including in-file member hover
- Signature help
- Definition, declaration, type definition, and implementation
- References, document highlights, rename, prepare-rename, and linked editing
- Document symbols, folding ranges, selection ranges, inlay hints, and code lenses
- Semantic tokens (`full` + `range`)
- Quick fixes / code actions via `compiler/lsp/codeActionsAggregate.ts`
- Diagnostics, via Monaco markers
- Document, range, and on-type formatting

The following services are not implemented in Monaco because the standalone editor has no public provider API for them:

- Call hierarchy
- Workspace symbol search

Cross-file features resolve against the browser-only virtual workspace in `website/src/assets/monaco/workspace.ts` instead of a real file system.

## Navigation Architecture

All navigation features (hover, definition, declaration, type definition, implementation, references, rename, highlight) share a common resolution pipeline:

- `resolveCursorTarget(analysis, line, character, program)` in `compiler/lsp/navigation.ts` provides the shared cursor-target resolution for local single-file features.
- `resolveHoverWithLocalFallback(context)` in `compiler/lsp/crossFileNavigation.ts` is the single unified hover entrypoint that handles import paths, member expressions, and local hover in one function.
- `resolveDefinitionWithLocalFallback(context)` in `compiler/lsp/crossFileNavigation.ts` is the single unified definition entrypoint covering import paths, import specifiers, member expressions, ambient symbols, and local definitions.
- Shared ambient-module helpers (`detectAmbientExportEqualsName`, `findAmbientNamespaceBody`) live in `compiler/lsp/crossFileContext.ts` and are used by navigation, signature help, imported-declaration collection, and quick-fix import-suggestion paths alike.
- `findAmbientModuleReceiverCandidates(ast, receiverName)` in `compiler/lsp/crossFileContext.ts` finds the default/namespace import binding matching a member-expression receiver and returns the `node:`-stripped ambient module-name candidates; it is shared by definition navigation and signature help when resolving `obj.member` / `obj.member(...)` on a default- or namespace-imported module object.
- Shared function-type display formatters (`formatParameterLabel`, `formatFunctionTypeLabel`) live in `compiler/lsp/classResolver.ts` and are reused everywhere a parameter list or function-type signature is rendered as text.
