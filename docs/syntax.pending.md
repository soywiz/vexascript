# TypeScript Syntax Pending in MyLang Parser

This document tracks TypeScript syntax that is still missing.

Scope notes:

- This list is based on the current parser capabilities described in `docs/syntax.md` and the parser implementation.
- It is intentionally practical (roadmap-style), not a full formal grammar diff.
- Unless explicitly noted, items are missing in both `mylang` and `typescript` parser modes.

## Program and Modules

- `import` forms beyond named imports (`import x from`, namespace imports, side-effect imports, mixed/default+named combinations).
- `export` declarations (`export const`, `export function`, `export class`, `export default`, `export { ... }`, `export * from`).
- `export as namespace`.
- `import type` / `export type`.
- ES module string specifiers (`from "..."`) as part of real module syntax handling.

## Declarations

- `enum` declarations (`enum` and `const enum`).
- `namespace` / `module` declarations with full body parsing (currently skipped as opaque block).
- `declare` declarations beyond current support (`declare function`, `declare class`, `declare var/let/const/val`), including enums, namespaces/modules with typed members, and other ambient forms.
- Destructuring declarations (`let { a } = obj`, `let [x] = arr`).

## Type System Syntax

- Deeper function generic inference beyond current constrained type-parameter support.
- Mapped types and indexed access types (`{ [K in keyof T]: ... }`, `T[K]` in type position).
- Conditional types (`T extends U ? X : Y`).
- `keyof`, `typeof` (type query), `infer`.
- Utility for `as const` and const assertions.
- Angle-bracket type assertions (`<T>value`). TypeScript-style `value as T` assertions are supported.

## Class Syntax

- `get` / `set` accessors.
- Parameter properties in TypeScript classes (`constructor(public x: number)`).

## Function and Parameter Syntax

- Destructured parameters.
- `this` parameters (`function f(this: X, ...)`).
- Overload signatures.
- Async functions (`async function`, `await`).
- Generator functions (`function*`) and `yield`.

## Statements and Control Flow

- `with`.
- Labels and labeled `break` / `continue`.
- `switch` features still missing:
- multiple `default` validation and diagnostics.
- stricter fallthrough diagnostics behavior (if desired by project rules).

## Expressions

- RegExp literals (`/abc/`).
- Numeric formats beyond current support (hex, binary, octal, numeric separators, etc.).

## Object and Array Literals

- Methods in object literals (`{ f() {} }`).
- Sparse arrays behavior.

## Error Recovery and Diagnostics (TypeScript-oriented)

- Rich diagnostics for unsupported TS syntax (actionable messages per construct).
- Recovery strategies around module/type syntax to continue parsing more of a file.
- Validation diagnostics for TS-specific constraints (duplicate defaults in switch, invalid modifier combinations, etc.).

## Tooling/Formatting Gaps Related to Pending Syntax

- Formatter support for all pending syntax categories above.
- LSP keyword/code actions for constructs beyond variable declarations.
- AST traversal updates for new statement/expression kinds once introduced.
