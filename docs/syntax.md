# MyLang Supported Syntax

This document tracks the language syntax currently supported by MyLang.

## Variables

### Declaration keywords

MyLang supports variable declaration statements using:

- `let`
- `var`
- `val`
- `const`

Examples:

```mylang
let a = 1
var b = 2
val c: Num
const d: Num = 4
```

### Optional type annotation and initializer

Variable declarations support:

- optional type annotation (`: TypeName`)
- optional initializer (`= expression`)
- multiple declarators separated by commas

Examples:

```mylang
let name: UserName = currentUser
let counter: Int
let enabled
val a = 10 * 2, lol = true
```

## Functions

Functions can be declared with `fun` or TypeScript-style `function`. Both forms support `async` and generator modifiers when emitted to JavaScript:

```mylang
async function load(id: string): Promise<Response> {
  return await fetch(id)
}

function* ids() {
  yield 1
}
```

A TypeScript `this` parameter may appear first in a function-like parameter list for type analysis. It is erased during JavaScript emission:

```mylang
function bind(this: Loader, id: string): string {
  return id
}
```

Type assertions with `as Type`, angle-bracket assertions, and const assertions are parsed and erased during JavaScript emission. Const assertions keep the analyzed expression type without attempting to resolve `const` as a named type:

```mylang
let name = value as string
let precise = [1, 2] as const
let other = <string>value
```


### Function declarations

MyLang supports function declarations with both keywords:

- `fun`
- `function`

Examples:

```mylang
fun add(a, b) {
  return a + b
}

function sum(a, b) {
  return a + b
}
```

### Ambient declarations

MyLang supports ambient declarations with `declare` for functions, classes, and variables (`var` / `let` / `const` / `val`).

Example:

```mylang
declare function moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;
declare class Console {
  log(a: number)
}
declare var console: Console
```

A cached ECMAScript ambient runtime is loaded automatically for every analysis session, so common globals such as `Array`, `Map`, `Set`, `Math`, `JSON`, `console`, `Date`, `RegExp`, `Promise`, and `Error` are available without imports. The declarations live in `compiler/runtime/ecmascript.d.my` and are copied to `dist/ecmascript.d.my` by the build so language-server declaration navigation can open the declaration file next to the bundled executable.

### Parameters

Function parameters support:

- plain parameters (`a`)
- optional marker (`a?`)
- optional type annotation (`a: Int`)
- optional default value (`a: Int = demo`)
- rest parameters (`...items: Item[]`), which must be last

Examples:

```mylang
fun test(a, v, c?, d: Int = demo) {
  return d
}

fun collect(label: string, ...values: int[]) {
  return values
}
```

### Return type annotation

Functions support optional return type annotation:

```mylang
fun demo(a, b): Int {
  return a + b
}
```


### Function overloads

Multiple top-level functions may share the same source name when their parameter type signatures differ. During JavaScript emission, overloaded implementations are currently name-mangled with their parameter types, and typed calls are rewritten to the matching emitted name:

```my
function describe(value: int): string { return "int" }
function describe(value: string): string { return value }

describe(1)      // emits as describe__int(1)
describe("one")  // emits as describe__string("one")
```

Signature-only overload declarations may be written without a body and are omitted from JavaScript output.

### Operator overloads

Classes can declare binary operator overload methods with `operator` followed by the operator token. The current runtime lowering emits a mangled method name and rewrites matching binary expressions to method calls:

```my
class Point(val x: number, val y: number) {
  operator+(other: Point): Point {
    return new Point(this.x + other.x, this.y + other.y)
  }
}

let c = a + b // emits as a.operator__plus(b) when a is Point
```

### Generic function declarations

Function declarations support generic type parameters, and explicit generic type arguments on calls specialize parameter and return types:

```mylang
fun identity<T>(value: T): T {
  return value
}

let name: string = identity<string>("Ada")
```

### Function expressions and arrow functions

MyLang parser supports TypeScript-style function expressions and arrow functions in expression position.

Examples:

```mylang
[1, 2, 3, 4].map(a => 10)
[1, 2, 3, 4].map((it) => 10)
[1, 2, 3, 4].map(function(it: number) { return 10 })
```

### Tail lambdas

MyLang also supports Kotlin/Swift-style tail lambdas after call expressions.

Examples:

```mylang
[1, 2, 3, 4].map { it }
[1, 2, 3, 4].map() { it }
[1, 2, 3, 4].map { a, b, c -> a + b + c }
[1, 2, 3, 4].map { a: number, b: number, c: number -> a + b + c }
```

## Imports

MyLang supports ES module imports at top level, including named imports, aliases, default imports, namespace imports, side-effect imports, and type-only imports:

```mylang
import { Point } from "./a"
import { Point, Vector as Vec } from "./geometry/types"
import React from "react"
import React, { useState as useLocalState } from "react"
import * as fs from "fs"
import "./setup"
import type { Shape } from "./types"
```

Type-only imports participate in semantic analysis as bindings but are omitted from emitted JavaScript output.

## Exports

MyLang supports ES module exports for declarations, named export lists, re-exports, default exports, and type-only export lists:

```mylang
export const answer: number = 42
export function add(a: number, b: number): number {
  return a + b
}
export class Point
export default Point
export { Point as RenamedPoint }
export { Shape } from "./shape"
export * from "./math"
export type Name = string
export type { Shape } from "./types"
export as namespace MyLib
```

Type-only exports and exported type aliases/interfaces participate in analysis but are omitted from emitted JavaScript output. `export as namespace` is supported for TypeScript-style global UMD declarations; it participates in parsing and editor highlighting and is omitted from JavaScript output.

## Classes

Class methods support `async` and generator modifiers:

```mylang
class Store {
  async save() {
    return await persist(this)
  }

  *values() {
    yield 1
  }
}
```


### Class declarations

MyLang supports class declarations:

```mylang
class Demo {
}
```

In MyLang mode, class braces are optional for empty class declarations:

```mylang
class Point
```

Class declarations also support:

- generic type parameters and constraints (`class Box<T extends Entity>`)
- `extends` clauses
- `implements` clauses (type-only, omitted in emitted JavaScript)
- `abstract` classes for abstract member declarations

Examples:

```mylang
class Base<T> {
}

interface Entity {
  id: string
}

class Box<T extends Entity> extends Base<T> {
}
```

### Get and set accessors

Class bodies support TypeScript-style property accessors. Getter accessors must not declare parameters, and setter accessors must declare exactly one parameter. Accessor type annotations participate in member type analysis as property types.

Example:

```mylang
class Box {
  get value(): string {
    return this.raw
  }

  set value(next: string) {
    this.raw = next
  }
}
```

### Optional primary constructor

Class declarations support an optional primary constructor parameter list after the class name.

Each primary constructor parameter currently supports:

- optional declaration kind (`let`, `var`, `val`, `const`, defaults to `val` when omitted)
- parameter name
- optional type annotation (`: TypeName`)
- optional default value (`= expression`)

Example:

```mylang
class Point(val x: number, val y: number) {
}
```

```mylang
class Point(x: number, y: number) {
}
```

This form also allows omitting braces in MyLang mode:

```mylang
class Point(val x: number, val y: number)
```

### Class fields

Class fields support:

- field name
- optional marker (`field?: TypeName`)
- definite assignment assertion marker (`field!: TypeName`)
- optional type annotation (`: TypeName`)
- optional initializer (`= expression`)
- access modifiers (`public`, `private`, `protected`)
- `readonly` fields (assignable from constructors, diagnosed on later writes)
- `static` fields

Examples:

```mylang
class Demo {
  a = 10
  b: Int = 20
  c: Int
  public readonly id?: string
  private static count: Int = 0
  service!: Service
}
```

### Class methods and constructor

Class members can be methods, including `constructor`. Methods support access modifiers (`public`, `private`, `protected`), `static`, and `abstract` signatures inside abstract classes. Derived class methods can use `super` calls and `super.member` access to reference inherited base-class behavior:

```mylang
class Demo {
  constructor() {
  }

  demo() {
  }
}
```

Method signatures support the same parameter syntax as function declarations.

Class fields and methods also support the `override` modifier when redefining members from a base class:

```mylang
class Base {
  value: string
}

class Child extends Base {
  override value: string
}
```

### Interfaces

MyLang supports interface declarations, including generic parameters and `extends`:

```mylang
interface PairStore<K, V> extends Iterable<K> {
  keys: K[]
  values: V[]
  get(key: K): V
}
```

`interface` declarations are type-only and are omitted from emitted JavaScript output.


### Enums

MyLang supports TypeScript-style `enum` and `const enum` declarations with numeric auto-increment members, numeric initializers, and string initializers. Enum declarations create a named semantic type, enum member access is checked as a known member, and non-ambient enums emit JavaScript runtime enum objects. Ambient `declare enum` declarations participate in analysis but are omitted from emitted JavaScript.

Examples:

```mylang
enum Direction {
  Up,
  Down = 4,
  Left,
  Right = "right"
}

const enum Status {
  Ready = 1,
  Done
}

let direction: Direction = Direction.Up
```

### Type aliases

MyLang supports type aliases for naming another supported type annotation form. Aliases may be generic and can be used anywhere a type annotation is accepted:

```mylang
type Text = string
type Boxed<T> = Box<T>
type Status = "ready" | "done"
type Pair = [string, int]
type UserKey = keyof User
type UserName = User["name"]
type NameCopy = typeof currentUser.name
let name: Text = "Ada"
let boxed: Boxed<Text> = new Box<string>()
```

`type` declarations are type-only and are omitted from emitted JavaScript output.

### Type annotation forms

Supported type annotation forms in declarations/members:

- plain type names (`Point`, `number`, `K`)
- primitive/builtin type names (`int`, `number`, `string`, `boolean`, `bigint`, `long`, `void`, `null`, `undefined`, `any`, `unknown`, `never`, `object`, `symbol`)
- generic type references (`Map<K, V>`)
- array suffixes (`K[]`, `Map<K, V>[]`)
- union types (`string | number`)
- intersection types (`Named & Serializable`)
- function types (`(value: int) => string`, including optional and rest parameters)
- object type literals (`{ x: int; label?: string }`)
- literal types (`"ready"`, `404`, `true`)
- tuple types (`[string, int]`)
- `keyof` type operators (`keyof User`)
- `typeof` type queries over values and dotted members (`typeof config`, `typeof user.name`)
- indexed access types (`User["name"]`, `Tuple[0]`, `User[keyof User]`)

## Expressions

### Literals

Supported literals:

- integer literals (`10`)
- decimal/scientific number literals (`10.573`, `10e-3`)
- numeric separators (`1_000`, `10.5_25`, `1e1_0`)
- non-decimal integer literals (`0xff`, `0b1010`, `0o755`)
- bigint literals (`10n`, `0xfn`)
- long literals (`10L`, `0xffL`)
- string literals (`"hello"`, `'hello'`)
- template string literals with interpolation (`` `hello ${name}` ``)
- regular expression literals (`/abc+/gi`)
- boolean literals (`true`, `false`)
- nullish literals (`null`, `undefined`)
- array literals (`[1, 2, 3]`) with spread elements (`[0, ...values]`) and sparse holes (`[1, , 3]`)
- object literals (`{a: 1, b: 2}`), including shorthand properties, spread properties, computed keys, string/number literal keys, and method properties (`{ add(a, b) { return a + b } }`)

### Unary operators

Supported unary operators:

- unary plus (`+x`)
- unary minus (`-x`)
- logical not (`!x`)
- bitwise not (`~x`)
- `typeof x`
- `void x`
- `delete x`
- `await x`
- `yield x` and `yield* iterable` in generator functions
- prefix increment (`++x`)
- prefix decrement (`--x`)
- postfix increment (`x++`)
- postfix decrement (`x--`)

### Binary operators

Supported binary operators:

- range: `...`
- exponentiation: `**`
- multiplicative: `*`, `/`, `%`
- additive: `+`, `-`
- shift: `<<`, `>>`, `>>>`
- relational: `<`, `>`, `<=`, `>=`, `in`, `instanceof`
- equality: `==`, `!=`, `===`, `!==`
- bitwise: `&`, `^`, `|`
- logical: `&&`, `||`, `??`

### Assignment operators

Supported assignment operators:

- `=`
- `+=`, `-=`, `*=`, `/=`, `%=`
- `<<=`, `>>=`, `>>>=`
- `&=`, `|=`
- `&&=`, `||=`
- `??=`

### Conditional and comma operators

MyLang supports ternary conditional expressions:

```mylang
condition ? whenTrue : whenFalse
```

Comma expressions are supported at the lowest expression precedence. They evaluate operands left-to-right and use the final operand type during semantic analysis:

```mylang
let value: string = (log(), "ok")
for (let i = 0; i < 10; i++, total += i) {
  work
}
```

Comma-delimited lists such as call arguments and array elements remain separate syntax, so `fn(a, b)` is parsed as two arguments. Use parentheses for a comma expression argument, for example `fn((a, b))`.

### Regular expression literals

MyLang supports JavaScript-style regular expression literals in expression positions. They are emitted unchanged and are inferred semantically as `RegExp` named values, which can be supplied by ambient declarations or host TypeScript definitions.

```mylang
declare class RegExp {}
let matcher: RegExp = /a[0-9]+/gi
```

### Type assertions

MyLang supports TypeScript-style `value as TypeName` and angle-bracket `<TypeName>value` assertions in expressions. Assertions are erased during JavaScript emission and the semantic checker treats the expression as the asserted target type. The checker reports an unsafe assertion when neither the source type nor target type is assignable to the other.

```mylang
let value: unknown = readValue()
let name: string = value as string
let count: number = <number>rawCount
```

### Range expressions

Range expressions are supported with `start ... end`:

```mylang
0 ... 10
```

`...` is end-exclusive, so `0 ... 10` iterates/generates values from `0` to `9`.

### Member access

Supported member access forms:

- dot access: `obj.prop`
- safe access: `obj?.prop`
- non-null asserted access: `obj!.prop`
- computed access: `obj[index]`
- optional computed access: `obj?.[index]`

Optional member and computed access include `undefined` in their inferred result type.

### Array literals

Array literals preserve TypeScript/JavaScript sparse holes during emission and runtime execution. A hole contributes `undefined` to semantic element inference, so `[1, , 3]` is compatible with an `(int | undefined)[]` expectation and emits as a sparse JavaScript array.

```mylang
let values: (int | undefined)[] = [1, , 3]
```

### Object literals

Object literals support explicit properties, shorthand properties, spread properties, computed keys, string literal keys, number literal keys, optional trailing commas, and later properties override earlier spread properties during semantic shape inference:

```mylang
let name = "Ada"
let base = { id: 1, name: "Base" }
let user = { name, ...base, name: "Grace", [dynamicKey]: value, "display name": name, 1: value, }
```

Object spread operands are semantically checked as object-compatible values. Known object, class, and interface member types are merged into the inferred object shape.

### Function calls

Function call expressions are supported, including calls chained from member access, optional calls, spread arguments, and optional generic type arguments:

```mylang
hello.world[0].test(arg1, arg2)
maybeCallback?.(arg1, arg2)
collect("label", ...values)
factory<string, number>(arg1, arg2)
```

### New expressions

TypeScript-style `new` expressions are supported, including constructor arguments, generic type arguments, and member-based constructor targets:

```mylang
new instance()
new instance
new Map<string, string>()
new hello.world[0].test(arg1, arg2)
```

## Statements and control flow

### Block statements

Blocks are supported with braces:

```mylang
{
  let a = 1
  let b = 2
}
```

### While

```mylang
while (condition) {
  doWork
}
```

### With

MyLang supports TypeScript-style `with` statements. The object expression and body are visited during semantic analysis, and the statement is preserved during JavaScript emission.

```mylang
with (scope) {
  use(value)
}
```

### Switch statements

MyLang supports `switch` statements with `case` and `default` clauses. Semantic analysis reports an error when a switch body contains more than one `default` clause, and LSP diagnostics expose a dedicated duplicate-default diagnostic code.

```mylang
switch (value) {
  case 1:
    break
  default:
    break
}
```

### Do-while

```mylang
do {
  work
} while (condition)
```

### For

MyLang supports TypeScript-style `for` loops:

```mylang
for (let i = 0; i < 10; i += 1) {
  work
}
```

Each clause is optional:

```mylang
for (;;) {
  break
}
```

MyLang also supports `for-in` without declaration keyword:

```mylang
for (value in iterable) {
  work
}
```

MyLang also supports `for-of` without declaration keyword:

```mylang
for (value of iterable) {
  work
}
```

Range iteration syntax is supported and transpiles to a classic index loop:

```mylang
for (a of 0 ... 10) console.log(a)
```

When running in `typescript` parser mode, `for-in` and `for-of` with declaration iterators are supported:

```typescript
for (let value in iterable) {
  use(value);
}

for (const value of iterable) {
  use(value);
}
```

### If / else

MyLang supports TypeScript-style `if` statements with optional `else`:

```mylang
if (condition) {
  doWork
} else {
  fallback
}
```

### Switch / case / default

MyLang supports TypeScript-style `switch` statements with `case` and optional `default`:

```mylang
switch (value) {
  case 1:
    return 1
  default:
    return 0
}
```

### Return, continue, break, debugger, and empty statements

Supported statements:

- `return`
- `return expression`
- `throw expression`
- `continue`
- `continue label` for labeled loop targets
- `break`
- `break label` for active statement labels
- `debugger`
- empty statements (`;`), including as loop bodies such as `while (condition);`

### Statement labels

Statements can be labeled. Labeled `break` targets may reference any active label, while labeled `continue` targets must reference a label whose statement is a loop.

```mylang
outer: while (running) {
  if (done) break outer
  continue outer
}

blockLabel: {
  break blockLabel
}
```

### Try / catch / finally

MyLang supports TypeScript-style exception handling:

```mylang
try {
  riskyWork()
} catch (err) {
  throw err
} finally {
  cleanup()
}
```

## Program structure

Statements can be separated by:

- semicolons
- newlines

Examples:

```mylang
let a = 1
let b = 2;
a += b
```

## Comments

MyLang supports two comment styles:

- single-line comments with `//`
- block comments with `/* ... */`

Examples:

```mylang
let a = 1 // single-line comment

/*
multi-line
block comment
*/
let b = 2
```

## TypeScript parser mode

When the parser runs in `typescript` mode, it supports ES module imports (`import { ... } from "..."`, default imports, namespace imports, side-effect imports, and `import type`), ambient declarations (`declare function`, `declare class`, `declare interface`, `declare var/let/const`), TypeScript-style `for` statements (including `for-in` / `for-of` with declaration iterators), `if` / `else` statements, `switch` / `case` / `default`, and `throw` / `try` / `catch` / `finally`.

Example:

```typescript
import { Point } from "./a";
declare function moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;
declare class Console {
  log(a: number)
}
declare var console: Console

for (let i = 0; i < 10; i += 1) {
  const current = i;
}

if (current > 0) {
  current--;
}

switch (current) {
  case 1:
    break;
  default:
    break;
}

try {
  risky(current);
} catch (err) {
  throw err;
} finally {
  cleanup();
}
```

## Semantic Rules (Current)

### Name resolution

- Global scope allows forward references to declarations.
- Local/function scopes require a symbol to be declared before use.

### Builtin types and assignability

- Builtin types: `int`, `number`, `string`, `boolean`, `bigint`, `long`, `void`, `null`, `undefined`, `any`, `unknown`, `never`, `object`, `symbol`.
- `int` is assignable to `number`.
- `long` is assignable to `bigint`.
- `any` is assignable to and from all types.
- `never` is assignable to all types.
- All types are assignable to `unknown`.
- Object literals, named/class/interface shapes, arrays, and functions are assignable to `object`.
- Literal types are assignable to their matching primitive type, but primitive values are not assignable to a specific literal type unless contextual checking proves the literal value matches.
- A value is assignable to a union if it is assignable to at least one union member.
- A value is assignable to an intersection if it satisfies every intersection member.
- Tuple values are assignable to tuple targets with the same length and compatible element types, and tuple values are assignable to arrays when each tuple element is assignable to the array element type.
- Function type annotations are checked structurally by parameter and return types.
- Object type literal annotations are checked structurally by their property names and types; optional properties include `undefined` in their semantic type.
- Other assignability checks are strict by type identity in the current version.

### Expression typing

- Integer literals have type `int`.
- Decimal/scientific numeric literals have type `number`.
- BigInt literals have type `bigint`.
- Long literals have type `long`.
- String literals have type `string`.
- Boolean literals have type `boolean`.
- `null` has type `null`.
- `undefined` has type `undefined`.
- Regular expression literals have the named type `RegExp`.
- `+`, `-`, `*`, `/`, `%`, shifts and bitwise operators on `int` operands infer `int`.
- `+` with at least one `string` operand infers `string`.
- Comparisons/equality/logical operators infer `boolean`.
- `start ... end` infers `range<int>` and is end-exclusive.

### Long runtime lowering

- `long` literals are lowered to JavaScript `bigint` literals (`10L` -> `10n`).
- Long arithmetic/bitwise expression results are wrapped as `BigInt.asIntN(64, expression)` to keep 64-bit signed behavior.

### Collection typing

- Array literals infer an element type from their items. Sparse holes contribute `undefined` to element inference.
- When an array literal is checked against an expected array type, that element type is used as context for nested generic calls.
- When an array literal is checked against an expected tuple type, each tuple element type is used as context for the corresponding array element.
- Homogeneous arrays infer typed arrays, for example `int[]`.
- Mixed incompatible arrays fall back to `unknown[]`.
- Object literals checked against an expected object, class, or interface type use matching property types as context for nested generic calls.
