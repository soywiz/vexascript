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

Examples:

```mylang
let name: UserName = currentUser
let counter: Int
let enabled
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

### Binary operators

Supported binary operators:

- exponentiation: `**`
- multiplicative: `*`, `/`, `%`
- additive: `+`, `-`
- relational: `<`, `>`, `<=`, `>=`
- equality: `===`, `!==`
- bitwise: `&`, `^`, `|`
- logical: `&&`, `||`

### Assignment operators

Supported assignment operators:

- `=`
- `+=`, `-=`, `*=`, `/=`, `%=`
- `&=`, `|=`
- `&&=`, `||=`

### Member access

Supported member access forms:

- dot access: `obj.prop`
- safe access: `obj?.prop`
- non-null asserted access: `obj!.prop`
- computed access: `obj[index]`

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

When the parser runs in `typescript` mode, it supports ambient function declarations with `declare function` and TypeScript-style `for` statements.

Example:

```typescript
declare function moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;

for (let i = 0; i < 10; i += 1) {
  const current = i;
}
```
