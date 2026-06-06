# Pending Tasks

This document tracks the current technical backlog for MyLang.

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
`compiler/lsp/nodeSearch.ts` backed by `compiler/ast/traversal.ts`). Future
quick fixes should use `nodeSearch.ts`/`walkAst` instead of adding bespoke
recursive visitors. The remaining items below are larger refactors that need
their own focused change with tests:

- Cross-file declaration resolution is implemented twice: the semantic
  `TypeChecker` and the LSP `classResolver`/`crossFileNavigation` independently
  walk imports/runtime/project to resolve a type name to its declaration. A
  shared "resolve declaration across files" abstraction would remove the
  divergence risk.

## Transpilation and Runtime

- Cross-file extension members (operators and named methods) resolve to their
  receiver-mangled standalone functions only when the local module graph is
  bundled (`bundleModuleGraph`), which strips local imports. When emitting a
  single module to real ES modules, the source-level import (e.g.
  `import { operator+ }` / `import { distance }`) is not yet rewritten to the
  mangled export name, so non-bundled cross-file usage would not link. Extension
  properties already rewrite their imported name; methods/operators should get
  the same treatment if non-bundled ESM output becomes a target.
