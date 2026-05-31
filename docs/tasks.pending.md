# Pending Tasks

This document tracks the current technical backlog for MyLang.

## High Priority

- Add cross-file/project symbol indexing for global go-to-definition and find-references.

## Semantic Analysis

- Add object shape types and interface member resolution.
- Improve array type propagation through expressions and assignments.
- Expand function type compatibility rules beyond strict structural equality.
- Add better diagnostics for type mismatches in nested expressions.
- Add generic type parameters and instantiation flow (functions/classes/interfaces).

## Parser and Recovery

- Add token-level error nodes or recover markers in AST to improve downstream diagnostics quality.

## Transpilation and Runtime

- Add optional transpile target modes (for example: conservative JS vs optimized JS).
- Add integration tests for emitted JavaScript behavior on complex language features.
- Add a lowering/optimization pass boundary before emission (instead of mixing optimizations directly in emitter).

## Documentation

- Keep `docs/syntax.md` updated whenever syntax evolves.
