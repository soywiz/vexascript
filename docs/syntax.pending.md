# TypeScript Syntax Pending in MyLang Parser

This document tracks TypeScript syntax that is still missing.

Scope notes:

- This list is based on the current parser capabilities described in `docs/syntax.md` and the parser implementation.
- It is intentionally practical (roadmap-style), not a full formal grammar diff.
- Unless explicitly noted, items are missing in both `mylang` and `typescript` parser modes.

## Program and Modules

- `import` declarations (`import x from`, named imports, namespace imports, side-effect imports).
- `export` declarations (`export const`, `export function`, `export class`, `export default`, `export { ... }`, `export * from`).
- `export as namespace`.
- `import type` / `export type`.
- ES module string specifiers (`from "..."`) as part of real module syntax handling.

## Declarations

- `type` aliases.
- `interface` declarations.
- `enum` declarations (`enum` and `const enum`).
- `namespace` / `module` declarations with full body parsing (currently skipped as opaque block).
- `declare` declarations beyond `declare function` (for variables, classes, enums, namespaces, modules, etc.).
- Variable declaration lists (`let a = 1, b = 2`).
- Destructuring declarations (`let { a } = obj`, `let [x] = arr`).

## Type System Syntax

- Union and intersection types (`A | B`, `A & B`) in annotations.
- Literal types (`"x"`, `123`, `true` as types).
- `any`, `unknown`, `never`, `void`, `object`, `symbol`, `bigint`.
- Array and tuple types (`T[]`, `[A, B]`).
- Function types (`(a: A) => B`).
- Type literals (`{ a: string }` as type).
- Generics (`<T>`) in functions, classes, interfaces, and type aliases.
- Type arguments in expressions (`fn<T>()`).
- Mapped types and indexed access types (`{ [K in keyof T]: ... }`, `T[K]` in type position).
- Conditional types (`T extends U ? X : Y`).
- `keyof`, `typeof` (type query), `infer`.
- Utility for `as const` and const assertions.
- Type assertions (`value as T`, `<T>value`).
- Definite assignment assertion on declarations (`field!: Type`).

## Class Syntax

- `extends` and `implements`.
- Access modifiers (`public`, `private`, `protected`).
- `readonly` members.
- `static` members.
- Abstract classes and abstract members.
- `get` / `set` accessors.
- Optional class fields (`field?: T`).
- Parameter properties in TypeScript classes (`constructor(public x: number)`).
- `super` calls and `super.member`.

## Function and Parameter Syntax

- Rest parameters (`...args`).
- Destructured parameters.
- `this` parameters (`function f(this: X, ...)`).
- Overload signatures.
- Arrow functions (`(a) => a + 1`).
- Function expressions (`const f = function () {}`).
- Async functions (`async function`, `await`).
- Generator functions (`function*`) and `yield`.

## Statements and Control Flow

- `try` / `catch` / `finally`.
- `throw`.
- `for...of`.
- `for...in`.
- `with`.
- Labels and labeled `break` / `continue`.
- `debugger`.
- Proper empty statements (`;`) in all positions.
- `switch` features still missing:
- multiple `default` validation and diagnostics.
- stricter fallthrough diagnostics behavior (if desired by project rules).

## Expressions

- Function calls (`fn()`, `obj.method()`).
- `new` expressions.
- Conditional/ternary operator (`cond ? a : b`).
- Nullish coalescing (`??`) and `??=`.
- Optional call (`fn?.()`).
- Optional element access (`obj?.[k]`).
- Logical not (`!expr`) and bitwise not (`~expr`).
- `delete`, `void`, `typeof` (expression operator).
- `instanceof`, `in`.
- Comma operator.
- Spread syntax in arrays/objects (`[...a]`, `{ ...x }`).
- Template literals (`` `hello ${name}` ``).
- RegExp literals (`/abc/`).
- BigInt literals (`123n`).
- `this` keyword handling.
- `null`, `true`, `false`, `undefined` as dedicated literal nodes/keywords.
- Numeric formats beyond decimal integers (hex, binary, octal, numeric separators, decimals/exponents).

## Object and Array Literals

- Shorthand object properties (`{ a }`).
- Methods in object literals (`{ f() {} }`).
- Computed object keys (`{ [k]: v }`).
- Optional trailing commas and sparse arrays behavior.

## Error Recovery and Diagnostics (TypeScript-oriented)

- Rich diagnostics for unsupported TS syntax (actionable messages per construct).
- Recovery strategies around module/type syntax to continue parsing more of a file.
- Validation diagnostics for TS-specific constraints (duplicate defaults in switch, invalid modifier combinations, etc.).

## Tooling/Formatting Gaps Related to Pending Syntax

- Formatter support for all pending syntax categories above.
- LSP keyword/code actions for constructs beyond variable declarations.
- AST traversal updates for new statement/expression kinds once introduced.
