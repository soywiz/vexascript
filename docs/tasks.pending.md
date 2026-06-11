# Pending Tasks

This document tracks the current technical backlog for VexaScript.

## High Priority

## Semantic Analysis

All current high-priority semantic analysis backlog items are implemented.

## Architecture and Maintainability

The following duplication/coupling gaps were identified during an architecture
review. The low-risk, behavior-preserving consolidations have already been
applied (shared `compiler/moduleResolution.ts` for local import resolution, a
single `BUILTIN_TYPE_NAMES` in `compiler/analysis/types.ts`, shared
`classPropertyParameters`/`constructorParameterProperties` exported from
`compiler/lsp/classResolver.ts`, `unwrapExportedDeclaration` in
`compiler/ast/traversal.ts`, and shared LSP quick-fix target lookup via
`compiler/lsp/nodeSearch.ts` backed by `compiler/ast/traversal.ts`, and shared
cross-file top-level declaration resolution via
`compiler/lsp/declarationResolver.ts`, and imported extension-member completion
now reuses `compiler/moduleResolution.ts`). Future quick fixes should use
`nodeSearch.ts`/`walkAst` instead of adding bespoke recursive visitors, and LSP
features that need top-level declarations across imports/runtime/project files
should use `declarationResolver.ts` instead of open-coding import walks. The
remaining items below are larger refactors that need their own focused change
with tests:

- Extract a shared LSP request-handler core from `compiler/lsp/server.ts` and
  `compiler/lsp/server-browser.ts`. Both register ~20 nearly identical handlers
  (completion, code actions, formatting, navigation, rename, symbols, signature
  help, folding, semantic tokens, inlay hints, call hierarchy); only the
  workspace/cross-file context differs. A `serverCore.ts` taking the context as
  a parameter would shrink both entrypoints to thin adapters and stop the two
  servers from drifting apart.
- Split `compiler/lsp/completion.ts` (~2.5k lines) by completion strategy
  (member completion, import completion, keyword fallback) with shared types in
  a small model module.
- Split `compiler/lsp/crossFileNavigation.ts` (~2.2k lines) by operation
  (definition, hover, references, rename) with shared cross-file member/type
  resolution helpers.

## Transpilation and Runtime

All current transpilation/runtime backlog items are implemented. Future gaps
should be added here when identified.
