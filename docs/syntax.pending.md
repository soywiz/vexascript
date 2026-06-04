# TypeScript Syntax Pending in MyLang Parser

This document tracks TypeScript syntax that is still missing.

Scope notes:

- This list is based on the current parser capabilities described in `docs/syntax.md` and the parser implementation.
- It is intentionally practical (roadmap-style), not a full formal grammar diff.
- Unless explicitly noted, items are missing in both `mylang` and `typescript` parser modes.

## Declarations

- `namespace` / `module` declarations with full body parsing (currently skipped as opaque block).
- `declare` declarations beyond current support (`declare function`, `declare class`, `declare var/let/const/val`, `declare enum`), including namespaces/modules with typed members and other ambient forms.

## Type System Syntax

- Deeper function generic inference beyond current constrained type-parameter support.

## Statements and Control Flow

- Stricter switch fallthrough diagnostics behavior (if desired by project rules).

## Error Recovery and Diagnostics (TypeScript-oriented)

- Rich diagnostics for unsupported TS syntax (actionable messages per construct).
- Recovery strategies around module/type syntax to continue parsing more of a file.
- Validation diagnostics for TS-specific constraints (invalid modifier combinations, etc.).

## Tooling/Formatting Gaps Related to Pending Syntax

- Formatter support for all pending syntax categories above.
- LSP keyword/code actions for constructs beyond variable declarations.
- AST traversal updates for new statement/expression kinds once introduced.
