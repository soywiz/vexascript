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
`compiler/lsp/declarationResolver.ts`, imported extension-member completion
now reuses `compiler/moduleResolution.ts`, both LSP transports now share the
request-handler core in `compiler/lsp/serverCore.ts`, class-body member
insertion points share `bodyEndInsertRange` in `compiler/lsp/ranges.ts`,
quick-fix target lookup shares the size-ranked best-match searches in
`compiler/lsp/nodeSearch.ts` and `findNode` in `compiler/ast/traversal.ts`
instead of bespoke statement visitors, and the ECMAScript/DOM declaration
modules share the load/cache/retry plumbing in
`compiler/runtime/declarationProgramCache.ts`, and the emitter's per-emission
globals are consolidated into the single `ActiveEmitState` object in
`compiler/runtime/emitter.ts`, where save/restore is one assignment and new
fields are enforced by object-literal completeness).
Future quick fixes should use
`nodeSearch.ts`/`walkAst` instead of adding bespoke recursive visitors, and LSP
features that need top-level declarations across imports/runtime/project files
should use `declarationResolver.ts` instead of open-coding import walks. The
remaining items below are larger refactors that need their own focused change
with tests:

- Split `compiler/lsp/completion.ts` (~2.5k lines) by completion strategy
  (member completion, import completion, keyword fallback) with shared types in
  a small model module.
- Split `compiler/lsp/crossFileNavigation.ts` (~2.2k lines) by operation
  (definition, hover, references, rename) with shared cross-file member/type
  resolution helpers.

## Transpilation and Runtime

All current transpilation/runtime backlog items are implemented. Future gaps
should be added here when identified.
