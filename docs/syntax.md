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

### Destructuring declarations

Variable declarations support nested object and array binding patterns. Object bindings may use shorthand names, property aliases, defaults, and rest bindings. Array bindings may use holes, defaults, nested patterns, and rest bindings.

```mylang
let { id, name: displayName, nested: { value = 1 }, ...rest } = source
const [first, , third = 3, ...tail] = values
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

In `async` functions, return expressions are checked against the inner `Promise<T>` value type, so both `return 10` and `return Promise.resolve(10)` are valid for `Promise<int>`. `await expr` evaluates to `T` when `expr` has type `Promise<T>`; otherwise `await` preserves the original type. When no return type is annotated, the inferred return type is `Promise<T>`. If an `async` function has an explicit return type annotation, it must be `Promise<...>`.

### `sync` functions (implicit await)

The `sync` modifier declares a function that behaves like `async` internally (it is emitted as a JavaScript `async function` and may use `await`), but with two ergonomic differences:

- The return type is written **without** the `Promise<...>` wrapper. `sync fun load(): Response` is internally an async function returning `Promise<Response>`; from the outside (and from other functions) the call is observed as `Promise<Response>`, so it participates in auto-await just like any other Promise.
- Inside a `sync` function body, any expression statement, variable initializer, or assignment right-hand side whose type is `Promise<T>` is **automatically awaited**, and its observed type becomes `T`.

```mylang
sync fun fetchValue(): int {
  return 1
}

sync fun main(): int {
  let x = fetchValue()   // emitted as: let x = await fetchValue();  -> x: int
  fetchValue()           // emitted as: await fetchValue();
  return x + 10
}
```

`sync` is also valid on methods, arrow functions, and function expressions (`class C { sync m(): int { ... } }`, `sync () => { ... }`, `sync function () { ... }`).

#### The `go` contextual operator

To opt out of the implicit await and obtain the underlying `Promise<T>`, prefix the expression with the contextual `go` operator. `go expr` is not awaited and keeps the `Promise<T>` type:

```mylang
sync fun main(): void {
  let pending: Promise<int> = go fetchValue()  // emitted as: let pending = fetchValue();
  go fetchValue()                              // fire-and-forget, emitted as: fetchValue();
}
```

`go` is contextual: it only acts as the no-await operator when an operand follows on the same line. Otherwise it remains a normal identifier, so existing code using `go` as a variable or function name keeps working.

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

### Runtime namespaces and modules

Runtime `namespace` and identifier-named `module` declarations group values behind a JavaScript object. Exported variables, functions, classes, enums, and nested namespaces become object members; declarations without `export` remain private to the generated namespace closure. Semantic analysis validates exported member access, and member completion offers the exported namespace surface.

```mylang
namespace Tools {
  const prefix = "v"
  export const version = 1
  export function label(): string { return prefix + version }
}

console.log(Tools.label())
```

Runtime namespaces are lowered to the conventional JavaScript namespace object plus IIFE pattern. String-literal module names remain restricted to ambient external modules such as `declare module "pixi.js"`.

### Ambient declarations

MyLang supports ambient declarations with `declare` for functions, classes (including `abstract class`), variables (`var` / `let` / `const` / `val`), type aliases, interfaces, enums, namespaces, and modules. Ambient declarations can also be wrapped in TypeScript-style `export declare`. In `typescript` parser mode, ambient external modules may use a string-literal name such as `declare module "pixi.js"`. Ambient namespace and module bodies preserve supported declarations in the AST, participate in scoped semantic analysis and semantic highlighting, and are erased during JavaScript emission. Unsupported declaration-file members are recovered as opaque regions so large third-party `.d.ts` files remain parseable.

Example:

```mylang
declare function moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;
declare type MomentFactory = (input: moment.MomentInput) => moment.Moment;
export declare abstract class Clock {}
declare class Console {
  log(a: number)
}
declare var console: Console
declare namespace Company.Tools {
  export interface Config {
    name: string
  }
  export const version: string
}
declare module "pixi.js" {
  export = PIXI;
}
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

Parameters also support object and array binding patterns, including nesting, property aliases, defaults, holes, and rest bindings. The introduced binding names are available throughout the function body, and the patterns are preserved in emitted JavaScript:

```mylang
function unpack(
  { id, nested: { value = 1 }, ...metadata },
  [first, , ...tail] = values
) {
  return value
}
```

### Return type annotation

Functions support optional return type annotation:

```mylang
fun demo(a, b): Int {
  return a + b
}
```

When the body is just a single returned expression, declarations and class methods can also use `=>` shorthand:

```mylang
fun demo(a, b): Int => a + b

class Point(val x: number, val y: number) {
  operator*(other: Point): Point => Point(x * other.x, y * other.y)
}
```


### Function overloads

Multiple top-level functions may share the same source name when their parameter type signatures differ. During JavaScript emission, overloaded implementations are currently name-mangled with their parameter types, and typed calls are rewritten to the matching emitted name:

```my
function describe(value: int): string { return "int" }
function describe(value: string): string { return value }

describe(1)      // emits as describe$$int(1)
describe("one")  // emits as describe$$string("one")
```

Signature-only overload declarations may be written without a body and are omitted from JavaScript output.

### Inline JavaScript implementations

A bodyless function may use `@JsImpl` to provide a trusted JavaScript template that is inserted at each direct call site. Parameter identifiers in the template are replaced with the emitted call arguments. When an argument is omitted, its declared default value is used; otherwise it is replaced with `undefined`.

```my
@JsImpl("if (!cond) throw new Error(message)")
fun assert(cond: boolean, message: string = "assert failed")

assert(value > 0)
```

The annotated declaration itself is omitted from JavaScript output. Templates are raw JavaScript and are responsible for being valid in every context where the function is called.

### Test files

The CLI `test` command discovers files ending in `.test.my`. Each test file receives inline `test(call)` and `assert(cond, message = "assert failed")` helpers without imports:

```my
test(() => {
  assert(2 * 3 == 6)
})
```

`test` invokes its callback, and `assert` throws an `Error` when its condition is false. The helpers are implemented with `@JsImpl`, so test execution does not require additional runtime files.

### Implicit member access

Inside a class method or field initializer, class members can be referenced without writing `this.`. Parameters and local variables still shadow members with the same name. JavaScript emission qualifies each resolved implicit member with `this.`:

```my
class Counter(val value: int) {
  increment(amount: int): int {
    return value + amount // emits as: return this.value + amount
  }
}
```

The same implicit receiver lookup is available inside extension methods and extension properties. Extension methods emit implicit members with `this.`, while extension-property arrow functions use their generated receiver parameter:

```my
fun Counter.doubled(): int { return value + value }
val Counter.next => increment(1)
```

### Operator overloads

Classes can declare binary operator overload methods with `operator` followed by the operator token. Mangled runtime names use `$` for operator names and `$$` before the parameter-type signature. The runtime lowering rewrites matching binary expressions to method calls:

```my
class Point(val x: number, val y: number) {
  operator+(other: Point): Point {
    return new Point(this.x + other.x, this.y + other.y)
  }
}

let c = a + b // emits as a.operator$plus$$Point(b) when a is Point
```

Binary operators may also be declared as extension methods by placing the receiver type before `.operator`. Extension operators are installed on the receiver prototype and participate in the same type-directed lowering:

```my
fun Point.operator+(other: Point): Point {
  return new Point(this.x + other.x, this.y + other.y)
}

let c = a + b // emits as a.operator$plus$$Point(b)
```

### Extension properties

A read-only extension property is declared with a receiver type before the property name and `=>` before its value expression. Inside the expression, `this` is the receiver value:

```my
class Duration(val milliseconds: number)
export val number.milliseconds => Duration(this)

val duration = 10.milliseconds
```

Extension properties are opt-in across files. A consumer imports the source-level property name, and access without that import is reported as a missing member:

```my
import { milliseconds } from "./duration"
val duration = 10.milliseconds
```

At JavaScript runtime, declarations and imports are mangled with the receiver type. For example, `number.milliseconds` is exported as `number$$milliseconds`, and `10.milliseconds` is lowered to `number$$milliseconds(10)`.

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

MyLang also supports Kotlin/Swift-style tail lambdas after call expressions and brace lambdas inside call argument lists. Inside an argument list, `{ name }` is context-sensitive: it is a one-parameter lambda with the implicit `it` parameter when the corresponding parameter type is a function, and a shorthand object literal when the parameter is not a function. The explicit `{ arg1, arg2 -> expression }` form is always a lambda.

Examples:

```mylang
[1, 2, 3, 4].map { it }
[1, 2, 3, 4].map() { it }
[1, 2, 3, 4].map { a, b, c -> a + b + c }
[1, 2, 3, 4].map { a: number, b: number, c: number -> a + b + c }
transform({ it })
transform({ value -> value + 1 })
consumeOptions({ options })
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

Class bodies support TypeScript-style property accessors. Getter accessors must not declare parameters, and setter accessors must declare exactly one parameter. Accessor type annotations participate in member type analysis as property types. Getters also support a shorthand form that omits `get` and the empty parameter list when the body is a single returned expression.

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

class Rect {
  area: number => this.width * this.height
}
```

### TypeScript constructor parameter properties

TypeScript-style constructors can promote parameters to instance properties by adding an access modifier (`public`, `private`, or `protected`) and/or `readonly`. Parameter properties participate in type analysis, access-control and readonly diagnostics, member completion/navigation, and are initialized automatically during JavaScript emission.

```mylang
class User {
  constructor(public readonly id: string, private age: int = 0) {
  }

  birthday() {
    this.age = this.age + 1
  }
}
```

Modifiers are only valid on parameters of a class `constructor`; ordinary function and method parameters cannot use them.

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

`type` declarations are type-only and are omitted from emitted JavaScript output. Mapped and conditional types are preserved structurally by the parser; semantic analysis resolves the portions it understands and otherwise treats them conservatively as `unknown`.

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
- mapped types (`{ [K in keyof T]?: T[K] }`)
- conditional types (`T extends U ? X : Y`)
- inferred conditional-type variables (`T extends (infer U)[] ? U : T`)

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
- relational: `<`, `>`, `<=`, `>=`, `in`, `is`, `instanceof`
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

### Class instantiation and new expressions

A declared class can be called directly to instantiate it. `ClassName(arguments)` is equivalent to `new ClassName(arguments)`:

```mylang
class Point(val x: int, val y: int)
let point = Point(1, 2)
```

TypeScript-style `new` expressions are also supported, including constructor arguments, generic type arguments, and member-based constructor targets:

```mylang
new instance()
new instance
new Map<string, string>()
new hello.world[0].test(arg1, arg2)
```

## Statements and control flow

### Smart casts

Within `if` and `else` branches, stable identifier types are narrowed by `is`, `instanceof`, and range-membership (`in`) checks. The false branch excludes the checked member from union types, and negated checks reverse the branch narrowing. `is` is emitted as JavaScript `instanceof`.

```mylang
if (value is Cat) {
  value.meow()
} else {
  value.bark()
}

if (value in 0 ... 10) {
  let numberValue: int = value
}
```

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

When the parser runs in `typescript` mode, it supports ES module imports (`import { ... } from "..."`, default imports, namespace imports, side-effect imports, and `import type`), ambient declarations (`declare function`, `declare type`, `declare abstract class`, `declare interface`, `declare enum`, `declare var/let/const`, and `export declare ...`), TypeScript-style `for` statements (including `for-in` / `for-of` with declaration iterators), `if` / `else` statements, `switch` / `case` / `default`, and `throw` / `try` / `catch` / `finally`.

Example:

```typescript
import { Point } from "./a";
declare function moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;
declare class Console {
  log(...a: number[])
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
