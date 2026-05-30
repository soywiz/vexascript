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

### Ambient function declarations

MyLang also supports ambient function declarations using `declare function`.

Example:

```mylang
declare function moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;
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

### Optional primary constructor

Class declarations support an optional primary constructor parameter list after the class name.

Each primary constructor parameter currently supports:

- declaration kind (`let`, `var`, `val`, `const`)
- parameter name
- optional type annotation (`: TypeName`)
- optional default value (`= expression`)

Example:

```mylang
class Point(val x: number, val y: number) {
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

## Expressions

### Literals

Supported literals:

- integer literals (`10`)
- string literals (`"hello"`, `'hello'`)
- array literals (`[1, 2, 3]`)
- object literals (`{a: 1, b: 2}`)

### Unary operators

Supported unary operators:

- unary plus (`+x`)
- unary minus (`-x`)
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
- relational: `<`, `>`, `<=`, `>=`
- equality: `==`, `!=`, `===`, `!==`
- bitwise: `&`, `^`, `|`
- logical: `&&`, `||`

### Assignment operators

Supported assignment operators:

- `=`
- `+=`, `-=`, `*=`, `/=`, `%=`
- `<<=`, `>>=`, `>>>=`
- `&=`, `|=`
- `&&=`, `||=`

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

Function call expressions are supported, including calls chained from member access:

```mylang
hello.world[0].test(arg1, arg2)
```

### New expressions

TypeScript-style `new` expressions are supported, including constructor arguments and member-based constructor targets:

```mylang
new instance()
new instance
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
- `continue`
- `break`

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

When the parser runs in `typescript` mode, it supports ambient function declarations with `declare function`, TypeScript-style `for` statements (including `for-in` / `for-of` with declaration iterators), `if` / `else` statements, and `switch` / `case` / `default`.

Example:

```typescript
declare function moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;

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
```
