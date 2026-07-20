# VexaScript Supported Syntax

This document tracks the language syntax currently supported by VexaScript.

## Variables

### Declaration keywords

VexaScript supports variable declaration statements using:

- `let`
- `var`
- `val`
- `const`

Examples:

```vexa
let a = 1
var b = 2
val c: number
const d: int = 4
```

### Optional type annotation and initializer

Variable declarations support:

- optional type annotation (`: TypeName`)
- optional initializer (`= expression`)
- multiple declarators separated by commas

Examples:

```vexa
let name: UserName = currentUser
let counter: int
let enabled
val a = 10 * 2, myboolean = true
```

### Delegated variables

Variables may use a Kotlin-like `by` delegate instead of an initializer. The delegate customizes reads and writes of the declared identifier. The delegate shape is selected from its compile-time type:

- `[value, setter]` reads from the first tuple element and writes with the second element as a `(newValue) => void` setter.
- `[getter, setter]` calls a zero-argument getter for reads and calls the setter for writes.
- `Property<T>` values produced by property references (`expr::field`) read and write through the delegate object's `value` property.
- `{ value: T }` reads and writes the delegate object's `value` property.
- A zero-argument function delegate is read by calling the function.

Assignments, compound assignments, and update expressions use the delegate setter/value path, so `x = x + 1`, `x += 1`, `x++`, `++x`, `x--`, and `--x` all route through the custom accessor.

```vexa
fun useState(value: number) {
  return [() => value, (newValue: number) => { value = newValue }]
}

var count by useState(0)
count = count + 1
count += 1
count++
```

### Property references

`expr::field` captures a reference to a concrete property. Its semantic type is `Property<T>`, where `T` is the property type. At runtime the receiver expression is evaluated once and lowered to an object with `name: string` and a get/set `value: T` property:

```vexa
class View(var x: number)

val view = View(0)
val property = view::x
property.value = 1
var x by property
x = 42 // writes view.x
```

Because `Property<T>` is a normal named type, extension operators can target property references. This makes property references useful for APIs that animate or bind a property without immediately reading it:

```vexa
fun Property<number>.operator[](src: number, dst: number): TweenTarget => TweenTarget(this, src, dst)

tween(view::x[0, 100], time: 1.seconds)
```

### Destructuring declarations

Variable declarations support nested object and array binding patterns. Object bindings may use shorthand names, property aliases, inline type annotations, defaults, and rest bindings. In VexaScript object destructuring, `:` introduces an inline type annotation and `::` renames a source property to a local binding. Array bindings may use holes, inline type annotations, defaults, nested patterns, and rest bindings. When the initializer has a tuple type, each introduced array binding receives the corresponding tuple element type unless an inline binding annotation overrides it. TypeScript mode keeps TypeScript destructuring rules: object binding `:` renames properties and destructuring patterns do not accept inline binding type annotations.

```vexa
let { id, name :: displayName, nested :: { value = 1 }, ...rest } = source
let { name : string, title :: displayTitle : string } = props
const [first : string, , third = 3, ...tail] = values
const [result, setResult] = useState(0) // result: int, setResult: (newValue: int) => void
```

## Functions

Functions can be declared with `fun` or TypeScript-style `function`. Both forms support `async` and generator modifiers. Supported generator functions can also be emitted by the native C++ backend as lazy C++20 coroutines:

```vexa
async function load(id: string): Promise<Response> {
  return await fetch(id)
}

function* ids() {
  yield 1
}
```

In `async` functions, return expressions are checked against the inner `Promise<T>` value type, so both `return 10` and `return Promise.resolve(10)` are valid for `Promise<int>`. `await expr` evaluates to `T` when `expr` has type `Promise<T>`; otherwise `await` preserves the original type. When no return type is annotated, the inferred return type is `Promise<T>`. If an `async` function has an explicit return type annotation, it must be `Promise<...>`.

`await` is only allowed at the top level (module/global scope) and inside `async` or `sync` functions. Using `await` inside a normal (non-`async`/`sync`) function or a normal generator is a semantic error (`AWAIT_OUTSIDE_ASYNC`).

`async` functions behave exactly like TypeScript: Promise-typed expressions are **not** implicitly awaited, so you write `await` explicitly. Pervasive auto-await is exclusive to `sync` functions (described below), which model Kotlin-style suspend functions.

### `sync` functions (implicit await)

The `sync` modifier declares a function that behaves like `async` internally (it is emitted as a JavaScript `async function` and may use `await`), but with two ergonomic differences:

- The return type is written **without** the `Promise<...>` wrapper. `sync fun load(): Response` is internally an async function returning `Promise<Response>`; from the outside (and from other functions) the call is observed as `Promise<Response>`, so it participates in auto-await just like any other Promise.
- Inside a `sync` function body, **any** subexpression whose type is `Promise<T>` is **automatically awaited** wherever it is used as a value, and its observed type becomes `T`. This applies everywhere — expression statements, variable initializers, assignment right-hand sides, call arguments, operands, array/object elements, and member receivers. This also works for Promise-returning functions imported from other files, including functions whose `Promise` return type is inferred from their body rather than annotated — the imported value's type is resolved from its declaring file, so calling it inside a `sync` function auto-awaits just like a local call.

```vexa
sync fun fetchValue(): int {
  return 1
}

sync fun main(): int {
  let x = fetchValue()                 // let x = await fetchValue();   -> x: int
  fetchValue()                         // await fetchValue();
  use(fetchValue(), fetchValue() + 1)  // use(await fetchValue(), (await fetchValue()) + 1);
  return x + 10
}
```

When the receiver of a member access is a Promise, it is awaited before the member is accessed, so `fetchBox().value()` becomes `(await fetchBox()).value()`. The exceptions, where the Promise is kept and **not** awaited, are:

- Accessing a Promise method (`.then`, `.catch`, `.finally`).
- `return` expressions (a returned Promise is flattened by the surrounding async function).
- **Bare references to a local variable or parameter.** Auto-await only happens at the point a Promise is *produced* (a call, a member call, ...), not when an already-stored Promise value is read. Once a Promise is held in a variable it keeps its `Promise<T>` type until it is awaited explicitly.

```vexa
sync fun demo(): void {
  let stored = go fetchValue()  // stored: Promise<int>  (go opts out)
  let alias = stored            // alias: Promise<int>   (local reference, not awaited)
  let inline = fetchValue()     // inline: int           (awaited at the call site)
}
```

`sync` is also valid on methods, arrow functions, and function expressions (`class C { sync m(): int { ... } }`, `sync () => { ... }`, `sync function () { ... }`).

#### The `go` contextual operator

To opt out of the implicit await and obtain the underlying `Promise<T>`, prefix the expression with the contextual `go` operator. `go expr` is never awaited and keeps the `Promise<T>` type, in any position:

```vexa
sync fun main(): void {
  let pending: Promise<int> = go fetchValue()  // let pending = fetchValue();
  go fetchValue()                              // fire-and-forget: fetchValue();
  use(go fetchValue())                         // pass the Promise along: use(fetchValue());
  go fetchValue().then(handle)                 // .then also keeps the Promise
}
```

`go` is contextual: it only acts as the no-await operator when an operand follows on the same line. Otherwise it remains a normal identifier, so existing code using `go` as a variable or function name keeps working.

Because `go` only has meaning where implicit auto-await happens, it is only allowed inside `sync` functions. Using `go` inside a normal or `async` function, or at the top level, is a semantic error (`GO_OUTSIDE_SYNC`).

A TypeScript `this` parameter may appear first in a function-like parameter list for type analysis. It is erased during JavaScript emission:

```vexa
function bind(this: Loader, id: string): string {
  return id
}
```

Type assertions with `as Type`, `satisfies Type`, const assertions, and non-null assertions are parsed and erased during JavaScript emission. `satisfies` checks assignability against the target type while preserving the original expression type, matching TypeScript's non-widening behavior. Const assertions keep the analyzed expression type without attempting to resolve `const` as a named type. Non-null assertions remove `null` and `undefined` from the analyzed expression type without changing runtime output. The angle-bracket cast `<Type>value` is TypeScript-only because VexaScript reserves `<` for embedded XML/JSX:

```vexa
let name = value as string
let config = { mode: "prod" } satisfies { mode: string }
let precise = [1, 2] as const
let definitelyName = maybeName!
```


### Function declarations

VexaScript supports function declarations with both keywords:

- `fun`
- `function`

Examples:

```vexa
fun add(a, b) {
  return a + b
}

function sum(a, b) {
  return a + b
}
```

### Runtime namespaces and modules

Runtime `namespace` and identifier-named `module` declarations group values behind a JavaScript object. Exported variables, functions, classes, enums, and nested namespaces become object members; declarations without `export` remain private to the generated namespace closure. Semantic analysis validates exported member access, and member completion offers the exported namespace surface.

```vexa
namespace Tools {
  const prefix = "v"
  export const version = 1
  export function label(): string { return prefix + version }
}

console.log(Tools.label())
```

Runtime namespaces are lowered to the conventional JavaScript namespace object plus IIFE pattern. String-literal module names remain restricted to ambient external modules such as `declare module "pixi.js"`.

### Ambient declarations

VexaScript supports ambient declarations with `declare` for functions, classes (including `abstract class`), variables (`var` / `let` / `const` / `val`), type aliases, interfaces, enums, namespaces, and modules. Ambient declarations can also be wrapped in TypeScript-style `export declare`. In `typescript` parser mode, ambient external modules may use a string-literal name such as `declare module "pixi.js"`. Ambient namespace and module bodies preserve supported declarations in the AST, participate in scoped semantic analysis and semantic highlighting, and are erased during JavaScript emission. Unsupported declaration-file members are recovered as opaque regions so large third-party `.d.ts` files remain parseable.

Example:

```vexa
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

A cached ECMAScript ambient runtime is loaded automatically for every analysis session, so common globals such as `Array`, `Map`, `Set`, `Math`, `JSON`, `console`, `Date`, `RegExp`, `Promise`, `Error`, and typed arrays such as `Uint8Array` are available without imports. The declarations live in `compiler/runtime/es2025.d.ts` and are copied to `dist/es2025.d.ts` by the build so language-server declaration navigation can open the declaration file next to the bundled executable.

### Parameters

Function parameters support:

- plain parameters (`a`)
- optional marker (`a?`)
- optional type annotation (`a: int`)
- optional default value (`a: int = demo`)
- rest parameters (`...items: Item[]`), which must be last

Examples:

```vexa
fun test(a, v, c?, d: int = demo) {
  return d
}

fun collect(label: string, ...values: int[]) {
  return values
}
```

Parameters also support object and array binding patterns, including nesting, property aliases with `::`, inline binding type annotations with `:`, defaults, holes, and rest bindings. The introduced binding names are available throughout the function body, and the patterns are preserved in emitted JavaScript with type-only annotations erased:

```vexa
function unpack(
  { id, nested :: { value = 1 }, label : string, name :: displayName : string, ...metadata },
  [first : string, , ...tail] = values
) {
  return value
}
```

### Return type annotation

Functions support optional return type annotation:

```vexa
fun demo(a, b): int {
  return a + b
}
```

When the body is just a single returned expression, declarations and class methods can also use `=>` shorthand:

```vexa
fun demo(a, b): int => a + b

class Point(val x: number, val y: number) {
  operator*(other: Point): Point => Point(x * other.x, y * other.y)
}
```


### Function overloads

Multiple top-level functions may share the same source name when their parameter type signatures differ. Re-declaring the exact same signature in the same file is a semantic error. During JavaScript emission, overloaded implementations are currently name-mangled with their parameter types, and typed calls are rewritten to the matching emitted name:

```my
function describe(value: int): string { return "int" }
function describe(value: string): string { return value }

describe(1)      // emits as describe$$int(1)
describe("one")  // emits as describe$$string("one")
```

Signature-only overload declarations may be written without a body and are omitted from JavaScript output.

### Inline JavaScript implementations

A bodyless function may use `@JsInline` to provide a trusted JavaScript template that is inserted at each direct call site. Parameter identifiers in the template are replaced with the emitted call arguments. When an argument is omitted, its declared default value is used; otherwise it is replaced with `undefined`.

```my
@JsInline("if (!cond) throw new Error(message)")
fun assert(cond: boolean, message: string = "assert failed")

assert(value > 0)
```

The annotated declaration itself is omitted from JavaScript output. Templates are raw JavaScript and are responsible for being valid in every context where the function is called.

### Custom JavaScript names

Annotations are declared explicitly and then applied with `@`:

```my
annotation Benchmark
annotation JsName(val name: string)
annotation JsInline(val replacement: string)
```

Zero-argument annotations may omit parentheses in both the declaration and each use site:

```my
annotation Benchmark

@Benchmark
fun measure() {}
```

The `@JsName("...")` annotation overrides the final JavaScript name of a declaration. It can be applied to functions, classes, enums, interfaces and variables. The source name is still used inside VexaScript, but JavaScript emission uses the supplied name for both the declaration and every reference to it:

```my
@JsName("rgba")
class Color(val r: int, val g: int, val b: int, val a: int)

@JsName("clamp01")
function clampUnit(value: number): number { return Math.max(0, Math.min(1, value)) }

val white = Color(255, 255, 255, 255)  // emits as new rgba(255, 255, 255, 255)
clampUnit(2)                           // emits as clamp01(2)
```

Member property names are not affected by `@JsName`; only the renamed declaration and references to it are rewritten. Annotations stack, so `@JsName` and `@JsInline` may be combined on the same declaration.

#### Annotations on class members

Annotations may also be applied to individual class members (fields and methods), written immediately before the member. They stack the same way as on top-level declarations, and their arguments are checked against the declared annotation parameters. Member annotations carry no runtime semantics and are erased from JavaScript output:

```my
annotation Range(val min: number, val max: number)

class Test extends Behaviour {
  @Range(0.1, 10.0)
  var scale: number

  @Deprecated
  fun init() {}
}
```

### Test files

The CLI `test` command discovers files ending in `.test.vx`. Each test file receives inline `test(call)` and `assert(cond, message = "assert failed")` helpers without imports:

```my
test(() => {
  assert(2 * 3 == 6)
})
```

`test` invokes its callback, and `assert` throws an `Error` when its condition is false. The helpers are implemented with `@JsInline`, so test execution does not require additional runtime files.

### Implicit member access

Inside a class method or field initializer, class members can be referenced without writing `this.`. Parameters and local variables still shadow members with the same name. JavaScript emission qualifies each resolved implicit member with `this.`:

```my
class Counter(val value: int) {
  increment(amount: int): int {
    return value + amount // emits as: return this.value + amount
  }
}
```

The same implicit receiver lookup is available inside extension methods and extension properties. Extension members are emitted as standalone receiver-mangled functions whose first parameter is the receiver (`$this`), so both implicit members and `this` resolve to that generated receiver parameter:

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

Binary operators may also be declared as extension methods by placing the receiver type before `.operator`. Unlike class operators (which stay prototype methods), extension members — operators, named methods and properties — are emitted as standalone functions whose mangled runtime name begins with the receiver type and whose first argument is the receiver. They participate in the same type-directed lowering:

```my
fun Point.operator+(other: Point): Point => Point(this.x + other.x, this.y + other.y)

let c = a + b // emits as Point$$operator$plus$$Point(a, b)
```

### Three-way comparison (spaceship) operator

The `<=>` operator performs a three-way comparison and evaluates to an `int`
ordering: `-1` when the left operand is less than the right, `0` when they are
equal, and `1` when the left is greater. It has the same precedence as the other
relational operators (`<`, `>`, `<=`, `>=`) and is left-associative, so
`(a <=> b) < 0` can be written `a <=> b < 0`.

For primitive operands (numbers, strings) it lowers to an inline comparison that
evaluates each operand once:

```my
let order = 1 <=> 2 // -1
let byName = "apple" <=> "banana" // -1
```

It is overloadable like the other binary operators, on classes or as an
extension, with the mangled runtime name `operator$spaceship`:

```my
class Money(val cents: int) {
  operator<=>(other: Money): int => cents <=> other.cents
}

let order = Money(150) <=> Money(99) // emits as new Money(150).operator$spaceship$$Money(new Money(99))
```

#### Derived comparisons

Declaring a single `operator<=>` is enough: when a type has no overload for a
specific comparison, `<`, `<=`, `>`, `>=`, `==`, and `!=` are each derived from
the spaceship result as `(a <=> b) OP 0`. Separately, when a type declares
`operator==` but no `operator!=`, the `!=` operator is derived as `!(a == b)`. A
direct overload for a specific operator always takes precedence over the derived
form.

```my
class Money(val cents: int) {
  operator<=>(other: Money): int => cents <=> other.cents
}

let cheaper = Money(99) < Money(150)   // (Money(99) <=> Money(150)) < 0
let same = Money(150) == Money(150)    // (Money(150) <=> Money(150)) == 0

class Tag(val name: string) {
  operator==(other: Tag): boolean => name == other.name
}

let different = Tag("a") != Tag("b")   // !(Tag("a") == Tag("b"))
```

#### Required definition for ordering comparisons

The ordering operators `<`, `>`, `<=`, `>=`, and `<=>` are only accepted when the
comparison is actually defined. A comparison is considered defined when either:

- one of the operands provides a matching overload — a direct one (e.g.
  `operator<`) or an `operator<=>` that derives the four relational operators; or
- the operands are natively comparable: a number with a number, a string with a
  string, or one operand is `any`/untyped/a bare generic type parameter.

Otherwise the operator is reported as undefined, for example comparing two
unrelated class instances or a string against a number:

```my
class Test
Test() < Test()   // error: Operator '<' is not defined for types 'Test' and 'Test'
"test" < 10       // error: Operator '<' is not defined for types 'string' and 'int'
```

Equality (`==`, `!=`, `===`, `!==`) and the logical operators are not restricted
this way.

Classes and extension methods can overload computed indexing with `operator[]` and `operator[]=`. Getter index operators receive the bracket dimensions in order. Setter index operators receive the assigned value first, followed by the bracket dimensions, so multidimensional setters keep a stable leading value parameter:

```my
class Array2<T>(val fallback: T) {
  operator[](x: int, y: int): T => fallback
  operator[]=(value: T, x: int, y: int): void { }
}

let array = Array2<string>("empty")
let cell = array[1, 2] // calls array.operator$get$$int$$int(1, 2)
array[1, 2] = "next" // calls array.operator$set$$string$$int$$int("next", 1, 2)
```

Rest parameters are supported for variable-dimensional indexers:

```my
class MultiArray<T>(val fallback: T) {
  operator[](...dimensions: int[]): T => fallback
  operator[]=(value: T, ...dimensions: int[]): void { }
}

let item = multi[1, 2, 3]
multi[1, 2, 3] = item
```

The same extension index operators can be declared on `Property<T>`, so property-reference expressions can act like lightweight bindable values:

```my
fun Property<number>.operator[](src: number, dst: number): TweenTarget => TweenTarget(this, src, dst)

tween(view::x[0, 100], time: 1.seconds)
```

Named extension methods follow the same scheme, so a call lowers to a plain function call with the receiver passed first:

```my
fun Counter.doubled(): int { return value + value }

let n = counter.doubled() // emits as Counter$$doubled$$void(counter)
```

### Extension properties

A read-only extension property is declared with a receiver type before the property name, an optional `: Type` annotation, and `=>` before its value expression. Inside the expression, `this` is the receiver value:

```my
class Duration(val milliseconds: number)
export val number.milliseconds => Duration(this)
val number.seconds: Duration => Duration(this * 1000)

val duration = 10.milliseconds
```

Extension properties are opt-in across files. A consumer imports the source-level property name, and access without that import is reported as a missing member:

```my
import { milliseconds } from "./duration"
val duration = 10.milliseconds
```

At JavaScript runtime, declarations and imports are mangled with the receiver type. For example, `number.milliseconds` is exported as `number$$milliseconds`, and `10.milliseconds` is lowered to `number$$milliseconds(10)`.

### Generic extension methods and properties

Extension methods and extension properties can be generic. Type parameters are written before the receiver type, and the receiver itself may carry type arguments — including built-in collection types such as `Array<T>`:

```my
fun <T> Array<T>.second(): T { return this[1] }
val <T> Array<T>.doubledLength => length * 2

let xs = [10, 20, 30]
let value = xs.second()        // 20
let total = xs.doubledLength   // 6
let empty = [].doubledLength   // 0
```

The receiver's base type name drives runtime mangling (the type arguments are erased), so `Array<T>` extensions are emitted as `Array$$...` functions and resolve for any array value, including array literals like `[]`. Inside the body, implicit member access resolves against the receiver type's members; for `Array<T>` receivers this includes built-in members such as `length`.

### Generic function declarations

Function declarations support generic type parameters, and explicit generic type arguments on calls specialize parameter and return types:

```vexa
fun identity<T>(value: T): T {
  return value
}

let name: string = identity<string>("Ada")
```

### Function expressions and arrow functions

VexaScript parser supports TypeScript-style function expressions and arrow functions in expression position.

Examples:

```vexa
[1, 2, 3, 4].map(a => 10)
[1, 2, 3, 4].map((it) => 10)
[1, 2, 3, 4].map(function(it: number) { return 10 })
```

### Tail lambdas

VexaScript supports Kotlin/Swift-style tail lambdas after call expressions, brace lambdas inside call argument lists, and brace lambdas anywhere an expression is accepted. Inside an argument list, `{ name }` is context-sensitive: it is a one-parameter lambda with the implicit `it` parameter when the corresponding parameter type is a function, and a shorthand object literal when the parameter is not a function. The same contextual shorthand is preserved in other expression positions when the surrounding type expects an object. The explicit `{ arg1, arg2 -> ... }` form is always a lambda.

The body after `->` may be a single expression or a sequence of statements. When it contains more than one statement, the lambda has a block body, and a final expression statement is emitted as an implicit `return`:

```vexa
[1, 2, 3].map {
  const doubled = it * 2
  doubled + 1 // implicit return
}

new Promise({ resolve, reject ->
  setTimeout(resolve, time.ms)
  setTimeout(reject, 1000)
})

useEffect({
  val timeout = schedule({
    count++
  }, 1000)
  return { clearTimer(timeout) }
}, [count])
```

Examples:

```vexa
[1, 2, 3, 4].map { it }
[1, 2, 3, 4].map() { it }
[1, 2, 3, 4].map { a, b, c -> a + b + c }
[1, 2, 3, 4].map { a: number, b: number, c: number -> a + b + c }
transform({ it })
transform({ value -> value + 1 })
consumeOptions({ options })
```

### Receiver function types

A function type may declare a receiver before the parameter list. Inside a contextually typed lambda, unqualified members and `this` refer to that receiver:

```vexa
fun <T> T.apply(block: T.() -> void): T {
  block(this)
  return this
}

class Point(var x: number, var y: number)

val point = Point(10, 20).apply {
  x = y * 2
  y = this.x * 3
}
```

The receiver is the function's first runtime argument. Consequently, receiver and ordinary function types with the same ordered arguments are structurally compatible:

```vexa
fun useReceiver(block: A.(B) -> void)
fun usePlain(block: (A, B) -> void)

fun A.test(b: B)
fun test(a: A, b: B)
```

The receiver is hidden only from the receiver-lambda parameter list. Calling the value directly still passes it first, as in `block(a, b)`.

The postfix receiver-block shorthand `value. { ... }` is an intrinsic receiver-in/receiver-out expression. It evaluates `value` once, runs the block with that value as its receiver, and returns the same value. It neither requires nor calls a member or extension named `apply`:

```vexa
Point(10, 20). {
  x *= 2
  y += x / 2
}
```

Conceptually the compiler-generated function has type `T.() -> T` and is immediately invoked with `value` as its first argument. JavaScript and C++ emit it directly at the use site, so no helper function is required at runtime.

Nested receiver lambdas select the nearest receiver for unqualified access. Use `this@functionName` to select the receiver introduced by a particular call:

```vexa
apply {
  demo {
    this@demo.x = 20
    this@apply.z = 30
  }
}
```

## Imports

VexaScript supports ES module imports at top level, including named imports, aliases, default imports, namespace imports, side-effect imports, and type-only imports:

```vexa
import { Point } from "./a"
import { Point, Vector as Vec } from "./geometry/types"
import React from "react"
import React, { useState as useLocalState } from "react"
import * as fs from "fs"
import "./setup"
import type { Shape } from "./types"
```

Type-only imports participate in semantic analysis as bindings but are omitted from emitted JavaScript output.

Relative imports can target local `.ts`/`.tsx` files as well as `.vx` files. Extensionless resolution checks the direct path, then `.vx`, `.ts`, `.tsx`, `.json`, and `.txt`. During `vexa run` and CLI bundling, local TypeScript modules are parsed in TypeScript mode, type-checked with their exported declarations available to the importing VexaScript file, transpiled to JavaScript, and inlined into the same executable module. This supports TypeScript runtime declarations such as classes, functions, variables, enums, destructuring, arrow functions, and async functions; type-only constructs such as interfaces and type aliases remain analysis-only and are erased from emitted JavaScript. Local JSON and text assets can be imported as default imports; JSON imports are parsed and inlined as JavaScript values, while text imports are inlined as strings.

```vexa
import { Color, Person, describePerson } from "./helpers"
import config from "./config.json"
import readme from "./readme.txt"

const ada = Person("Ada", 36)
console.log(describePerson(ada))
console.log(Color.Green)
console.log(config.title)
console.log(readme.trim())
```

Extension operator overloads declared in another file (for example `fun Point.operator+`) can be imported by their `operator` name so the operator resolves across files:

```vexa
import { Point, operator+ } from "./geometry"
val sum = Point(1, 2) + Point(3, 4)
```

An `operator+` binding is not a real runtime export: it is installed on the receiver's prototype as a side effect of loading the module, so it is dropped from the emitted named bindings while the module load is preserved. When a binary operator is reported as undefined and a matching overload exists in another file, a quick fix offers to add the `operator` import.

## Exports

VexaScript supports ES module exports for declarations, named export lists, re-exports, namespace re-exports, default exports, and type-only export lists:

```vexa
export const answer: number = 42
export function add(a: number, b: number): number {
  return a + b
}
export async fun loadAnswer(): Promise<number> {
  return 42
}
export sync fun loadCachedAnswer(): number {
  return loadAnswer()
}
export class Point
export namespace Geometry {
  export class Circle
}
export default Point
export { Point as RenamedPoint }
export { Shape } from "./shape"
export * from "./math"
export * as MathHelpers from "./math"
export type Name = string
export type { Shape } from "./types"
export as namespace MyLib
```

In VexaScript source files (`.vx`), top-level runtime declarations are exported implicitly unless they are marked `private`. This means `export` is optional for public top-level variables, functions, classes, enums, namespaces, extension methods, and extension properties:

```vexa
fun greet(name: string): string {
  return `Hello ${name}`
}

private fun hidden(): string {
  return "secret"
}
```

```vexa
import { greet } from "./helpers"
```

The explicit `export` keyword is still supported and remains useful for re-exports, default exports, type-only exports, and codebases that prefer the extra clarity at the declaration site.

Type-only exports and exported type aliases/interfaces participate in analysis but are omitted from emitted JavaScript output. Exported namespaces are supported both as runtime VexaScript declarations and in TypeScript declaration files such as `export namespace Models { ... }`. `export as namespace` is supported for TypeScript-style global UMD declarations; it participates in parsing and editor highlighting and is omitted from JavaScript output. Namespace re-exports such as `export * as MathHelpers from "./math"` emit as standard JavaScript namespace re-exports in ESM mode and as CommonJS namespace assignments in CommonJS mode.

## Classes

Class methods support `async` and generator modifiers:

```vexa
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

VexaScript supports class declarations:

```vexa
class Demo {
}
```

In VexaScript mode, class braces are optional for empty class declarations:

```vexa
class Point
```

Class declarations also support:

- generic type parameters and constraints (`class Box<T extends Entity>`)
- `extends` clauses
- `implements` clauses (type-only, omitted in emitted JavaScript)
- `abstract` classes for abstract member declarations

Examples:

```vexa
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

Native C++ emission supports synchronous instance getters in both forms and
synchronous setter accessors. Getter/setter pairs can implement mutable interface
properties, and concrete or interface-typed writes support direct, compound,
prefix, and postfix operations. Compound accessor blocks are not yet supported by
the native backend.

VexaScript also supports a compound accessor block where the property name is written once and `get`/`set` sub-blocks are nested inside `{ }`. The setter parameter defaults to the implicit name `newValue` typed to the declared property type; it can be overridden by writing `set(name)` or `set(name: Type)`. Either `get`/`set` order is accepted.

Example:

```vexa
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

class Point {
  private var _x = 0

  // compound form — name appears once
  var x: int {
    set { _x = 2 * newValue }      // implicit 'newValue' parameter
    get { return _x / 2 }
  }

  var y: int {
    set(value) { _x = 2 * value }  // explicit parameter name
    get => _x / 2                   // arrow shorthand getter
  }

  var z: int {
    set(value: int) { _x = value }  // explicit parameter name and type
    get { return _x }
  }
}
```

### TypeScript constructor parameter properties

TypeScript-style constructors can promote parameters to instance properties by adding an access modifier (`public`, `private`, or `protected`) and/or `readonly`. Parameter properties participate in type analysis, access-control and readonly diagnostics, member completion/navigation, and are initialized automatically during JavaScript emission.

```vexa
class User {
  constructor(public readonly id: string, private age: int = 0) {
  }

  birthday() {
    this.age = this.age + 1
  }
}
```

Modifiers are only valid on parameters of a class `constructor`; ordinary function and method parameters cannot use them.

### Class interface delegates

A class can satisfy an interface by delegating missing interface members to another value with `by` in its heritage clause. The delegate can be written as an expression, or as the common single-shorthand brace form used to expose an existing instance member. The delegated expression must resolve to a value assignable to the interface.

For each interface property or method that the class does not declare itself, VexaScript synthesizes a forwarding member at JavaScript emission time. Explicit class members win over delegated members with the same name.

```vexa
interface Shape {
  area: number
  fill(color: string): string
}

class MyDemo(val shape: Shape) : Shape by { shape } {
}
```

This is equivalent to writing the forwarding members by hand:

```vexa
class MyDemo(val shape: Shape) : Shape {
  area => shape.area
  fill(color: string) {
    return shape.fill(color)
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

```vexa
class Point(val x: number, val y: number) {
}
```

```vexa
class Point(x: number, y: number) {
}
```

This form also allows omitting braces in VexaScript mode:

```vexa
class Point(val x: number, val y: number)
```

### Class fields

Class fields support:

- optional declaration kind keywords (`var`, `let`, `val`, `const`) before the member name; the legacy keyword-less form still works
- field name
- optional marker (`field?: TypeName`)
- definite assignment assertion marker (`field!: TypeName`)
- optional type annotation (`: TypeName`)
- optional initializer (`= expression`)
- access modifiers (`public`, `private`, `protected`)
- `readonly` fields (assignable from constructors, diagnosed on later writes); `val` and `const` are the preferred immutable spellings inside class bodies
- `static` fields

Examples:

```vexa
class Demo {
  var a = 10
  let b: int = 20
  c: int
  public val id?: string
  private static var count: int = 0
  service!: Service
}
```

### Class methods and constructor

Class members can be methods, including `constructor`. Methods support the explicit `fun` keyword as the preferred spelling inside class bodies, while the older keyword-less form remains valid. Methods also support access modifiers (`public`, `private`, `protected`), `static`, and `abstract` signatures inside abstract classes. Derived class methods can use `super` calls and `super.member` access to reference inherited base-class behavior:

```vexa
class Demo {
  constructor() {
  }

  fun demo() {
  }
}
```

Method signatures support the same parameter syntax as function declarations.

Instance methods may also declare a `this` return type for fluent APIs in both VexaScript and TypeScript-style syntax:

```vexa
class Builder {
  fun next(): this {
    return this
  }
}
```

TypeScript-style computed method names are also supported, including async-iterator hooks such as `[Symbol.asyncIterator]()`:

```vexa
class Stream {
  async *[Symbol.asyncIterator](): AsyncGenerator<int> {
    yield 1
  }
}
```

Class fields and methods also support the `override` modifier when redefining a
member from a base class **or** from an implemented interface:

```vexa
class Base {
  value: string
}

class Child extends Base {
  override value: string
}
```

`override` is valid as long as a member with that name exists in some supertype
(the base-class chain or an implemented interface); otherwise it is reported as
`Member 'm' cannot override because no member with that name exists in base type
'B'`. When the overriding member's signature does not match the base-class
member it overrides, it is reported as `Member 'm' override type '...' does not
match base type '...'`, and the editor offers a "Fix signature of 'm' to match
base class 'B'" quick fix that rewrites the signature. The `override` modifier is
type-only and is erased from the emitted JavaScript.

Conversely, `override` is **required**: a member that redefines a member of a
project supertype (one of your own VexaScript classes or interfaces) without
`override` is reported as `Member 'm' must be declared with 'override' because it
overrides a member from a base class or interface`, with an "Add 'override'"
quick fix. This is scoped to VexaScript sources and the project's own types —
members conforming to imported/ambient (node_modules, `.d.ts`) types, and members
in TypeScript-mode files, do not require `override`.

A class may declare at most one `extends` clause and one `implements` clause (the
`implements` clause may list several interfaces separated by commas). Surplus
clauses parse but are reported (`A class can only extend a single class` /
`A class can only have one 'implements' clause; list multiple interfaces
separated by commas`).

#### Abstract and interface member conformance

A concrete (non-abstract) class must provide an implementation for every
abstract member it inherits from its abstract base-class chain, and for every
member of the interfaces it implements. A missing abstract member is reported as
`Non-abstract class 'C' does not implement inherited abstract member 'm' from
class 'B'`; a missing interface member is reported as `Class 'C' incorrectly
implements interface 'I'. Property 'm' is missing`. An abstract subclass is
exempt — it may leave inherited abstract members unimplemented for a further
subclass to provide.

```vexa
abstract class Shape {
  abstract fun area(): number
}

class Square extends Shape {   // error: does not implement 'area'
}
```

Implementing an abstract method with a signature that drops one of its required
parameters is also reported (`Class 'C' does not correctly implement abstract
member 'm' from class 'B'. Expected signature '...'`), with a "Fix signature"
quick fix. Trailing optional parameters may be omitted, so `render()` validly
implements `render(props?, state?)`.

```vexa
abstract class Test {
  abstract fun demo(a: int)
}

class Demo extends Test {
  demo() {}   // error: expected signature '(a: int) => void'
}
```

The editor offers an "Implement missing member" quick fix that inserts an
`override` stub (`override fun ...` for methods, `override ...` for properties)
for each missing abstract or interface member.

### Interfaces

VexaScript supports interface declarations, including generic parameters and `extends`. Interface members can also use the preferred explicit member keywords (`val` / `var` / `let` / `const` for properties and `fun` for methods), while the older TypeScript-style member form still works:

```vexa
interface PairStore<K, V> extends Iterable<K> {
  val keys: K[]
  val values: V[]
  fun get(key: K): V
  fun snapshot(): this
}
```

`interface` declarations are type-only and are omitted from emitted JavaScript output.

The native C++ backend supports required, non-generic method-and-property
interfaces with at most one base interface. Classes can conform to one interface
through either the colon form or `implements`; interface-typed parameters, fields,
local values, returns, and homogeneous arrays use virtual dispatch. Interface
properties can be implemented by primary-constructor or regular class fields;
`val`/`const` properties emit a getter, while mutable properties also support
direct, compound, prefix, and postfix writes through a virtual setter.


### Enums

VexaScript supports TypeScript-style `enum` and `const enum` declarations, including exported `export const enum` forms, with numeric auto-increment members, numeric initializers, and string initializers. Enum declarations create a named semantic type, enum member access is checked as a known member, and non-ambient enums emit JavaScript runtime enum objects. Ambient `declare enum` declarations participate in analysis but are omitted from emitted JavaScript.

Examples:

```vexa
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

The native C++ backend supports numeric enums whose explicit initializers are
integer arithmetic, shift, or bitwise constant expressions. Enum values can be
used in typed parameters, returns, arrays, comparisons, bitwise expressions, and
switch cases. Native string and ambient enums are rejected explicitly.

### Type aliases

VexaScript supports type aliases for naming another supported type annotation form. Aliases may be generic and can be used anywhere a type annotation is accepted:

```vexa
type Text = string
type Boxed<T> = Box<T>
type Status = "ready" | "done"
type MaybeName = string?
type Pair = [string, int]
type EventPath = [EventTarget?]
type UserKey = keyof User
type UserName = User["name"]
type NameCopy = typeof currentUser.name
type UtilModule = typeof import("node:util")
type UUID = `${string}-${string}-${string}-${string}-${string}`
type Stream<R> = import("stream/web").ReadableStream<R>
let name: Text = "Ada"
let boxed: Boxed<Text> = new Box<string>()
```

`type` declarations are type-only and are omitted from emitted JavaScript output. Mapped and conditional types are preserved structurally by the parser; semantic analysis resolves the portions it understands and otherwise treats them conservatively as `unknown`. Template literal types are also resolved when their interpolated members reduce to literal or union-of-literal values; when an interpolation stays wide (for example `${string}`), the result degrades conservatively to `string` instead of `unknown`. Top-level conditional aliases also resolve a practical subset of common `infer` patterns such as array element extraction, `Promise<infer T>`, function return types, constrained forms like `infer U extends string`, and nested conditional branches; naked-type-parameter conditionals also distribute over unions in common cases. TypeScript readonly container shorthand such as `readonly string[]` and `readonly [string, int]` is also resolved semantically, including readonly-aware assignability and write/mutation diagnostics for readonly index access. Homomorphic mapped aliases also support practical key-remapping forms such as `as K`, `as Exclude<K, ...>`, and template-literal remaps like `` as `label_${K}` ``, plus `readonly`/`-readonly` and `?`/`-?` modifiers when the remapped keys reduce to string literals. `unique symbol` currently resolves conservatively as `symbol`, and TypeScript assertion signatures such as `(value: unknown) => asserts value is T` or `(value: T) => asserts value` are preserved as assertion-aware function types that participate in flow-sensitive narrowing for direct call-site checks. Constructor-signature type forms such as `new (...) => T` and `abstract new (...) => T` are also understood well enough for utility aliases like `ConstructorParameters` and `InstanceType`. Common TypeScript utility aliases such as `Partial`, `Required`, `Readonly`, `Pick`, `Omit`, `Exclude`, `Extract`, `NonNullable`, `Record`, `Awaited`, `ReturnType`, `Parameters`, `ConstructorParameters`, `InstanceType`, `ThisParameterType`, `OmitThisParameter`, `NoInfer`, `ThisType`, `Uppercase`, `Lowercase`, `Capitalize`, and `Uncapitalize` are also resolved when their inputs fit the currently supported type forms.

Native C++ emission resolves non-generic aliases of supported native types,
including nested aliases and homogeneous array aliases. Generic and structural
aliases remain analysis-only for native builds.

### Type annotation forms

Supported type annotation forms in declarations/members:

- plain type names (`Point`, `number`, `K`)
- primitive/builtin type names (`int`, `number`, `string`, `boolean`, `bigint`, `long`, `void`, `null`, `undefined`, `any`, `unknown`, `never`, `object`, `symbol`)
- `unique symbol` type annotations, currently treated conservatively as `symbol`
- generic type references (`Map<K, V>`)
- array suffixes (`K[]`, `Map<K, V>[]`, `[int, number, Animation][]`)
- readonly container shorthand (`readonly string[]`, `readonly [string, int]`)
- optional type suffixes (`User?`, `(() => void)?`), equivalent to `User | undefined`
- union types (`string | number`)
- intersection types (`Named & Serializable`)
- function types (`(value: int) => string`, constructor signatures like `new (value: int) => Box`, and optional/rest parameters)
- object type literals (`{ x: int; label?: string }`)
- literal types (`"ready"`, `404`, `true`)
- tuple types (`[string, int]`, `[value: T, setter: (newValue: T) => void]`, `[EventTarget?]`)
- `keyof` type operators (`keyof User`)
- `typeof` type queries over values, dotted members, and module imports (`typeof config`, `typeof user.name`, `typeof import("node:util").format`)
- indexed access types (`User["name"]`, `Tuple[0]`, `User[keyof User]`)
- template literal types (`` `${string}-${string}` ``)
- import types (`import("stream/web").ReadableStream<R>`, `import("pkg").Thing`)
- mapped types (`{ [K in keyof T]?: T[K] }`, `{ [K in keyof T as Exclude<K, "id">]: T[K] }`, `{ [K in keyof T as `label_${K}`]-?: T[K] }`)
- conditional types (`T extends U ? X : Y`)
- inferred conditional-type variables (`T extends (infer U)[] ? U : T`)

## Expressions

### Literals

Supported literals:

- integer literals (`10`)
- decimal/scientific number literals (`10.573`, `10e-3`, `.5`, `.01`)
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

- range: `...` (inclusive), `..<` (exclusive)
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

### Cascade operator

The cascade operator `..` evaluates a receiver once, applies each following member operation to that same receiver, and returns the receiver. It is useful for constructing and configuring objects without repeating the variable name.

```vexa
val badge = Graphics()
  ..point = Vec2(centerX, centerY - 16)
  ..beginFill(0xff6b35)
  ..drawRoundedRect(-110, -64, 220, 128, 28)
  ..endFill()
```

This is equivalent to creating the `Graphics()` value, assigning `point`, calling the listed methods on that value, and using the configured value as the initializer for `badge`. Cascade operations currently support member assignments and member calls.

### Conditional and comma operators

VexaScript supports ternary conditional expressions:

```vexa
condition ? whenTrue : whenFalse
```

Comma expressions are supported at the lowest expression precedence. They evaluate operands left-to-right and use the final operand type during semantic analysis:

```vexa
let value: string = (log(), "ok")
for (let i = 0; i < 10; i++, total += i) {
  work
}
```

Comma-delimited lists such as call arguments and array elements remain separate syntax, so `fn(a, b)` is parsed as two arguments. Use parentheses for a comma expression argument, for example `fn((a, b))`.

### Regular expression literals

VexaScript supports JavaScript-style regular expression literals in expression positions. They are emitted unchanged and are inferred semantically as `RegExp` named values, which can be supplied by ambient declarations or host TypeScript definitions.

```vexa
declare class RegExp {}
let matcher: RegExp = /a[0-9]+/gi
```

### Type assertions

VexaScript supports TypeScript-style `value as TypeName` assertions in expressions. Assertions are erased during JavaScript emission and the semantic checker treats the expression as the asserted target type. The checker reports an unsafe assertion when neither the source type nor target type is assignable to the other.

```vexa
let value: unknown = readValue()
let name: string = value as string
```

The angle-bracket cast form `<TypeName>value` is **not** available in VexaScript, because `<` always begins an embedded XML/JSX element (see [Embedded XML / JSX](#embedded-xml--jsx)). The angle-bracket cast remains available only when the parser runs in TypeScript mode with JSX disabled (the default for `.d.ts`-style consumption).

### Embedded XML / JSX

VexaScript supports embedding XML directly in expressions, exactly like JSX/TSX. There is a single VexaScript mode and it always enables this: a `<` in expression position that is followed by a tag name (or `>` for a fragment) starts an element instead of a less-than operator.

```vexa
val greeting = <div class="greeting" id={userId}>Hello {name}!</div>
val list = <ul>{items.map((item) => <li key={item.id}>{item.name}</li>)}</ul>
val fragment = <><Header/><Body {...props}/></>
```

Supported features mirror JSX/TSX:

- Intrinsic elements with a lowercase tag name (`<div>`) and component/dotted tags (`<Foo>`, `<Foo.Bar>`).
- Self-closing elements (`<input/>`), fragments (`<>...</>`), and nested elements.
- Attributes: string values (`class="x"`), expression containers (`value={expr}`), boolean shorthand (`disabled`), and spread attributes (`{...props}`).
- Children: text (with JSX whitespace normalization), expression containers (`{expr}`), and nested elements.

Embedded XML is transpiled with the classic React runtime: elements become `React.createElement(...)` calls and fragments use `React.Fragment`. Intrinsic lowercase tags are emitted as string literals; component and dotted tags are emitted as references.

```js
// <div class="greeting">Hi {name}</div>
React.createElement("div", { class: "greeting" }, "Hi ", name)
```

The element factory and fragment factory are configurable. They default to the classic React runtime (`React.createElement` / `React.Fragment`) but can be overridden through the emitter/transpile options `jsxFactory` and `jsxFragmentFactory`, the `vexa build` flags `--jsx-factory` and `--jsx-fragment-factory`, or a project-level `tsconfig.json` (`compilerOptions.jsxFactory` and `compilerOptions.jsxFragmentFactory`). A `tsconfig.json` with `compilerOptions.jsxImportSource` set to `"preact"` is mapped to Preact's classic factories (`h` and `Fragment`) while VexaScript emits classic JSX factory calls.

```json
{
  "compilerOptions": {
    "jsxFactory": "h",
    "jsxFragmentFactory": "Fragment"
  }
}
```

```js
// with --jsx-factory h --jsx-fragment-factory Fragment or the tsconfig.json above
// <><span/></>
h(Fragment, null, h("span", null))
```

In TypeScript mode, embedded XML is opt-in through the `jsx` parser option; enabling it disables the angle-bracket cast (matching `.tsx` semantics).

### Range expressions

Range expressions are supported with `start ... end` (inclusive) and `start ..< end` (exclusive), matching Swift syntax:

```vexa
0 ... 10   // inclusive: 0, 1, 2, ..., 10
0 ..< 10   // exclusive: 0, 1, 2, ..., 9
```

`...` is end-inclusive, so `0 ... 10` iterates/generates values from `0` to `10`. `..<` is end-exclusive, so `0 ..< 10` iterates/generates values from `0` to `9`.

Useful in for loops:

```vexa
for (n of 0 ..< 10) {
  console.log(n)
}
// equivalent to
for (let n = 0; n < 10; n++) {
  console.log(n)
}
```


### Member access

Supported member access forms:

- dot access: `obj.prop`
- safe access: `obj?.prop`
- non-null asserted access: `obj!.prop`
- computed access: `obj[index]`
- optional computed access: `obj?.[index]`

Optional member and computed access include `undefined` in their inferred result type. Non-null asserted access removes `null` and `undefined` from the receiver type before resolving the member and is erased to normal dot access during JavaScript emission.

Assignments may also target optional member chains such as `countRef.current?.style?.background = "grey"`. These are emitted as guarded JavaScript expressions that first capture the nullable receiver into a temporary and only perform the final write when that receiver is non-nullish.

### Array literals

Array literals preserve TypeScript/JavaScript sparse holes during emission and runtime execution. A hole contributes `undefined` to semantic element inference, so `[1, , 3]` is compatible with an `(int | undefined)[]` expectation and emits as a sparse JavaScript array. TypeScript-style tuple type annotations use square brackets, including labeled tuple elements such as `[value: T, setter: (newValue: T) => void]`.

```vexa
let values: (int | undefined)[] = [1, , 3]
let state: [value: int, setter: (newValue: int) => void] = [0, (newValue: int) => {}]
```

### Object literals

Object literals support explicit properties, shorthand properties, spread properties, computed keys, string literal keys, number literal keys, optional trailing commas, and later properties override earlier spread properties during semantic shape inference:

```vexa
let name = "Ada"
let base = { id: 1, name: "Base" }
let user = { name, ...base, name: "Grace", [dynamicKey]: value, "display name": name, 1: value, }
```

Object spread operands are semantically checked as object-compatible values. Known object, class, and interface member types are merged into the inferred object shape.

### Function calls

Function call expressions are supported, including calls chained from member access, optional calls, spread arguments, and optional generic type arguments:

```vexa
hello.world[0].test(arg1, arg2)
maybeCallback?.(arg1, arg2)
collect("label", ...values)
factory<string, number>(arg1, arg2)
```

#### Named arguments

Call and `new` arguments may be passed by parameter name using `name: value`.
Named arguments can be written in any order and freely mixed with leading
positional arguments; the compiler reorders them into the callee's positional
parameter order when emitting JavaScript. Editor completion suggests the
available parameter names (for example `url:`) inside an argument list.

```vexa
fun connect(host: string, port: number) {}

connect(port: 8080, host: "localhost")   // reordered to connect("localhost", 8080)
connect("localhost", port: 8080)          // positional + named

class Point(val x: number, val y: number)
let point = Point(y: 2, x: 1)             // reordered to new Point(1, 2)
```

### Class instantiation and new expressions

A declared class can be called directly to instantiate it. `ClassName(arguments)` is equivalent to `new ClassName(arguments)`. Constructor-only ECMAScript globals from ambient declarations use the same class-call style, including calls with generic type arguments such as `Map<string, number>(entries)`:

```vexa
class Point(val x: int, val y: int)
let point = Point(1, 2)
let scores = Map<string, number>([["Ada", 3]])
```

TypeScript-style `new` expressions are also supported, including constructor arguments, generic type arguments, and member-based constructor targets:

```vexa
new instance()
new instance
new Map<string, string>()
new hello.world[0].test(arg1, arg2)
```

## Statements and control flow

### Smart casts

Within `if` and `else` branches, stable identifier types are narrowed by `is`, `instanceof`, and range-membership (`in`) checks. The false branch excludes the checked member from union types, and negated checks reverse the branch narrowing. `is` is emitted as JavaScript `instanceof`.

```vexa
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

```vexa
{
  let a = 1
  let b = 2
}
```

### While

```vexa
while (condition) {
  doWork
}
```

### With

VexaScript supports TypeScript-style `with` statements. The object expression and body are visited during semantic analysis, and the statement is preserved during JavaScript emission.

```vexa
with (scope) {
  use(value)
}
```

### Switch statements

VexaScript supports `switch` statements with `case` and `default` clauses. Semantic analysis reports an error when a switch body contains more than one `default` clause. It also reports non-empty cases that can fall through to a following case; add an explicit `break`, `return`, `throw`, or `continue` when a case should stop before the next label. LSP diagnostics expose dedicated codes for duplicate defaults and switch fallthrough.

```vexa
switch (value) {
  case 1:
    break
  default:
    break
}
```

### Do-while

```vexa
do {
  work
} while (condition)
```

### For

VexaScript supports TypeScript-style `for` loops:

```vexa
for (let i = 0; i < 10; i += 1) {
  work
}
```

Each clause is optional:

```vexa
for (;;) {
  break
}
```

VexaScript also supports `for-in` without declaration keyword:

```vexa
for (value in iterable) {
  work
}
```

VexaScript also supports `for-of` without declaration keyword:

```vexa
for (value of iterable) {
  work
}
```

Native C++ emission also supports declaration-based array and object
destructuring in `for-of` loops:

```vexa
for (val [key, value] of entries) consume(key, value)
for (val { name: string } of records) console.log(name)
```

Native C++ emission also supports declaration-based array and object
destructuring in `for-of` loops:

```vexa
for (val [key, value] of entries) consume(key, value)
for (val { name: string } of records) console.log(name)
```

Range iteration syntax is supported and transpiles to a classic index loop:

```vexa
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

VexaScript supports TypeScript-style `if` statements with optional `else`:

```vexa
if (condition) {
  doWork
} else {
  fallback
}
```

### Switch / case / default

VexaScript supports TypeScript-style `switch` statements with `case` and optional `default`. Non-empty cases must end control flow explicitly before the next label:

```vexa
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

```vexa
outer: while (running) {
  if (done) break outer
  continue outer
}

blockLabel: {
  break blockLabel
}
```

### Try / catch / finally

VexaScript supports TypeScript-style exception handling:

```vexa
try {
  riskyWork()
} catch (err) {
  throw err
} finally {
  cleanup()
}
```

The native C++ backend preserves abrupt completion through `finally`: cleanup runs
before a pending `return`, `throw`, `break`, or `continue`, while a new abrupt
completion inside `finally` replaces the pending one. This also applies to nested
`finally` blocks and to `defer`. Native labeled `break` and `continue` use the
same completion propagation, including jumps across nested loops and cleanup.

### Defer

`defer expression` schedules cleanup for the end of the current block. It wraps everything that remains in that block in a `try` / `finally`, so the deferred expression still runs when the block returns early or throws.

```vexa
val file = open()
defer file.close()
return file.read()
```

Equivalent to:

```vexa
val file = open()
try {
  return file.read()
} finally {
  file.close()
}
```

## Program structure

Statements can be separated by:

- semicolons
- newlines

Examples:

```vexa
let a = 1
let b = 2;
a += b
```

## Comments

VexaScript supports three comment styles:

- single-line comments with `//`
- documentation comments with `///`
- block comments with `/* ... */`

Examples:

```vexa
let a = 1 // single-line comment

/// searches [sub] in [str]
/// and returns its index or -1
fun find(str: string, sub: string): int { }

/*
multi-line
block comment
*/
let b = 2
```

## TypeScript parser mode

When the parser runs in `typescript` mode directly or because a local `.ts`/`.tsx` module is imported into a VexaScript module graph, it supports ES module imports (`import { ... } from "..."`, default imports, namespace imports, side-effect imports, and `import type`), ambient declarations (`declare function`, `declare type`, `declare abstract class`, `declare interface`, `declare enum`, `declare var/let/const`, and `export declare ...`), TypeScript-style `for` statements (including `for-in` / `for-of` with declaration iterators), `if` / `else` statements, `switch` / `case` / `default`, and `throw` / `try` / `catch` / `finally`.

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

- Builtin types: `int`, `number`, `numeric`, `string`, `boolean`, `bigint`, `long`, `void`, `null`, `undefined`, `any`, `unknown`, `never`, `object`, `symbol`.
- `int` is assignable to `number`.
- `long` is assignable to `bigint`.
- `numeric` is the common supertype of the integer family (`int`/`number`) and the big-integer family (`long`/`bigint`); `int`, `number`, `long`, and `bigint` are all assignable to `numeric`. The numeric tower is `numeric -> number -> int` and `numeric -> bigint -> long`.
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
- Decimal/scientific numeric literals, including leading-dot forms such as `.5`, have type `number`.
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
- `start ... end` infers `range<int>` and is end-inclusive; `start ..< end` infers `range<int>` and is end-exclusive.

### Long runtime lowering

- `long` literals are lowered to JavaScript `bigint` literals (`10L` -> `10n`).
- Long arithmetic/bitwise expression results are wrapped as `BigInt.asIntN(64, expression)` to keep 64-bit signed behavior.

### Collection typing

- Array literals infer an element type from their items. Sparse holes contribute `undefined` to element inference.
- When an array literal is checked against an expected array type, that element type is used as context for nested generic calls.
- When an array literal is checked against an expected tuple type, each tuple element type is used as context for the corresponding array element.
- Array literals returned from functions infer tuple return types, so generic helpers such as `useState<T>(value: T) { return [value, (newValue: T) => {}] }` preserve each destructured element type at call sites.
- Homogeneous arrays infer typed arrays, for example `int[]`.
- Mixed element types unify to their common supertype. Members of the numeric tower unify to `numeric`, so `[10, 10L]` (an `int` and a `long`) infers `numeric[]`.
- Mixed incompatible arrays (with no common supertype, for example `[10, "string"]`) fall back to `any[]`.
- An array variable whose element type is still unknown (for example `const array: unknown[] = []` or `let xs = []`) evolves its element type from the first `push`/`unshift` mutation, so `array.push(10)` refines the inferred type of `array` to `int[]`.
- Object literals checked against an expected object, class, or interface type use matching property types as context for nested generic calls.

The native C++ backend represents object literals as managed records. It supports
shorthand and computed keys, nested objects, ordered object spread, dot and
bracket access, direct/compound/update writes, optional property reads, `in`, and
`delete`. Structurally compatible record values use generated native adapters for
both properties and methods; callable fields and object-literal methods share the
dynamic callable representation.

Native C++ classes support abstract methods, concrete single inheritance,
virtual overrides, qualified `super.member` calls, access sections, and multiple
implemented interfaces. TypeScript-style derived constructors forward arguments
to non-default generated base constructors through `super(...)`; constructor
parameter properties initialize after the base and participate in native GC
tracing. Optional interface properties and methods may be omitted by concrete or
structural implementations.

Native CLI builds resolve transitive local modules and project import mappings
into one dependency-ordered translation unit. Named, aliased, default, namespace,
re-export, and side-effect imports are supported with module-local native symbol
identity.

Native async and sync functions are continuation-based C++20 coroutines: source
code runs synchronously until the first pending `await`, then resumes through the
runtime microtask queue. The native Promise surface includes executor creation,
`resolve`, `reject`, `then`, `catch`, `finally`, `all`, `race`, `allSettled`, and
`any`, including flattening a task returned by a continuation. Timers accept
heterogeneous callback arguments and async anonymous callbacks.
`readTextFile(path)` returns a `Promise<string>` whose native implementation reads
off-thread and settles through that same microtask queue.

The native standard-library subset includes the common mutating, searching,
slicing, concatenation, and higher-order array methods; common string search,
slicing, and splitting methods; and `Object.keys`/`Object.values` for managed
records. Higher-order array callbacks use ordinary typed VexaScript lambdas.
Managed arrays support `forEach`, `some`, `every`, `find`, `findIndex`, `at`,
`lastIndexOf`, `splice`, `fill`, `copyWithin`, `flat`, `flatMap`, and both lexical
`sort()` and comparator-based `sort(callback)` in addition to
`map`/`filter`/`reduce`. Native higher-order methods use the JavaScript callback
contract: `map`, `filter`, `forEach`, `some`, `every`, and `findIndex` supply
`(value, index, array)`, while `reduce` supplies
`(accumulator, value, index, array)`; callbacks may declare fewer parameters.
The native numeric remainder operator also supports both integral values and
floating-point `number` values.

Native `bigint` values are arbitrary precision and do not depend on a system
bigint library. Literals and `BigInt(...)` construction support arithmetic,
remainder, exponentiation with a non-negative exponent, comparisons, bitwise
operators, signed shifts, `String`/`Number`/`Boolean` conversion, homogeneous
arrays, and mixed dynamic arrays. The initial native division implementation is
intentionally simple and may be slow for very large operands.

Native arrays preserve JavaScript-style reference identity. Assigning one array
to another variable, passing it to a function, or storing it in multiple class
instances does not duplicate its contents; mutation through any reference is
visible through the others. Their backing storage and any managed object
elements are traced by Oilpan, including cycles, and become collectible after
the last reachable owner disappears. Operations defined to produce a new array,
including `slice`, `concat`, `map`, and `filter`, still return distinct backing
storage.

Native `concat` accepts both scalar items and arrays, including variadic mixtures
such as `values.concat(3, [4, 5], 6)`, matching the visible JavaScript API.

Native array string conversion uses a bracketed representation: `values.toString()`,
`String(values)`, template/string conversion paths, and `console.log(values)` all
format an array as `[item, item]` rather than exposing its C++ backing pointer.
