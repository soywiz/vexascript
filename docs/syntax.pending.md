# TypeScript Syntax Pending in MyLang Parser

This document tracks TypeScript syntax that is still missing.

Scope notes:

- This list is based on the current parser capabilities described in `docs/syntax.md` and the parser implementation.
- It is intentionally practical (roadmap-style), not a full formal grammar diff.
- Unless explicitly noted, items are missing in both `mylang` and `typescript` parser modes.

## Program and Modules

- `export as namespace`.
- ES module string specifiers (`from "..."`) as part of real module syntax handling.

## Declarations

- `namespace` / `module` declarations with full body parsing (currently skipped as opaque block).
- `declare` declarations beyond current support (`declare function`, `declare class`, `declare var/let/const/val`, `declare enum`), including namespaces/modules with typed members and other ambient forms.
- Destructuring declarations (`let { a } = obj`, `let [x] = arr`).

## Type System Syntax

- Deeper function generic inference beyond current constrained type-parameter support.
- Mapped types and indexed access types (`{ [K in keyof T]: ... }`, `T[K]` in type position).
- Conditional types (`T extends U ? X : Y`).
- `keyof`, `typeof` (type query), `infer`.
- Utility for `as const` and const assertions.
- Angle-bracket type assertions (`<T>value`). TypeScript-style `value as T` assertions are supported.

## Class Syntax

- Parameter properties in TypeScript classes (`constructor(public x: number)`).

## Function and Parameter Syntax

- Destructured parameters.
- Overload signatures.

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
