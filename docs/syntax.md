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

### Parameters

Function parameters support:

- plain parameters (`a`)
- optional marker (`a?`)
- optional type annotation (`a: Int`)
- optional default value (`a: Int = demo`)

Examples:

```mylang
fun test(a, v, c?, d: Int = demo) {
  return d
}
```

### Return type annotation

Functions support optional return type annotation:

```mylang
fun demo(a, b): Int {
  return a + b
}
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

MyLang supports named imports at top level:

```mylang
import { Point } from "./a"
import { Point, Vector } from "./geometry/types"
```

## Classes

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
- optional type annotation (`: TypeName`)
- optional initializer (`= expression`)

Examples:

```mylang
class Demo {
  a = 10
  b: Int = 20
  c: Int
}
```

### Class methods and constructor

Class members can be methods, including `constructor`:

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

### Type aliases

MyLang supports type aliases for naming another supported type annotation form. Aliases may be generic and can be used anywhere a type annotation is accepted:

```mylang
type Text = string
type Boxed<T> = Box<T>
let name: Text = "Ada"
let boxed: Boxed<Text> = new Box<string>()
```

`type` declarations are type-only and are omitted from emitted JavaScript output.

### Type annotation forms

Supported type annotation forms in declarations/members:

- plain type names (`Point`, `number`, `K`)
- generic type references (`Map<K, V>`)
- array suffixes (`K[]`, `Map<K, V>[]`)

## Expressions

### Literals

Supported literals:

- integer literals (`10`)
- decimal/scientific number literals (`10.573`, `10e-3`)
- bigint literals (`10n`)
- long literals (`10L`)
- string literals (`"hello"`, `'hello'`)
- template string literals with interpolation (`` `hello ${name}` ``)
- array literals (`[1, 2, 3]`)
- object literals (`{a: 1, b: 2}`)

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

### Conditional operator

MyLang supports ternary conditional expressions:

```mylang
condition ? whenTrue : whenFalse
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

### Function calls

Function call expressions are supported, including calls chained from member access and optional generic type arguments:

```mylang
hello.world[0].test(arg1, arg2)
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

### Return, continue, break

Supported statements:

- `return`
- `return expression`
- `throw expression`
- `continue`
- `break`

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

When the parser runs in `typescript` mode, it supports named imports (`import { ... } from "..."`), ambient declarations (`declare function`, `declare class`, `declare interface`, `declare var/let/const`), TypeScript-style `for` statements (including `for-in` / `for-of` with declaration iterators), `if` / `else` statements, `switch` / `case` / `default`, and `throw` / `try` / `catch` / `finally`.

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

- Builtin types: `int`, `number`, `string`, `boolean`, `bigint`, `long`.
- `int` is assignable to `number`.
- Other assignability checks are strict by type identity in the current version.

### Expression typing

- Integer literals have type `int`.
- Decimal/scientific numeric literals have type `number`.
- BigInt literals have type `bigint`.
- Long literals have type `long`.

### Long runtime lowering

- `long` literals are lowered to JavaScript `bigint` literals (`10L` -> `10n`).
- Long arithmetic/bitwise expression results are wrapped as `BigInt.asIntN(64, expression)` to keep 64-bit signed behavior.
- String literals have type `string`.
- `+`, `-`, `*`, `/`, `%`, shifts and bitwise operators on `int` operands infer `int`.
- `+` with at least one `string` operand infers `string`.
- Comparisons/equality/logical operators infer `boolean`.
- `start ... end` infers `range<int>` and is end-exclusive.

### Collection typing

- Array literals infer an element type from their items.
- When an array literal is checked against an expected array type, that element type is used as context for nested generic calls.
- Homogeneous arrays infer typed arrays, for example `int[]`.
- Mixed incompatible arrays fall back to `unknown[]`.
- Object literals checked against an expected object, class, or interface type use matching property types as context for nested generic calls.
