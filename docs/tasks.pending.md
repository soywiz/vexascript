# Pending Tasks

This document tracks the current technical backlog for MyLang.

## High Priority

- Add source maps to the transpile pipeline so JavaScript runtime errors map back to `.my` files.
- Expose expression-level type lookup by position for LSP hover and richer completions.
- Improve emitter output normalization with stable formatting rules (without changing semantics).

## Semantic Analysis

- Add object shape types and basic property type checking.
- Improve array type propagation through expressions and assignments.
- Expand function type compatibility rules beyond strict structural equality.
- Add better diagnostics for type mismatches in nested expressions.

## Parser and Recovery

- Add more recovery tests for nested malformed constructs (`if` inside `switch`, broken `for` headers, chained calls).
- Improve recovery heuristics for ambiguous newline-heavy code.

## Transpilation and Runtime

- Add optional transpile target modes (for example: conservative JS vs optimized JS).
- Add integration tests for emitted JavaScript behavior on complex language features.

## LSP and DX

- Add hover support with inferred type details.
- Add go-to-definition support for local and global symbols.
- Add rename-symbol support with scope awareness.

## Documentation

- Keep `docs/syntax.md` updated whenever syntax evolves.
- Add a dedicated semantic spec document describing assignability and inference rules.
- Add a transpilation design note documenting emitter invariants and optimization rules.
