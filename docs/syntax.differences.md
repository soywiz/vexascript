# VexaScript vs TypeScript: Syntax Differences

This document summarises the syntax additions and differences that VexaScript introduces on top of TypeScript. Everything valid in TypeScript that is not overridden here continues to work the same way.

## Variable declarations

### `val` keyword

VexaScript adds `val` as an immutable binding keyword, complementing TypeScript's `const`. Use `val` for immutable bindings—it is idiomatic in VexaScript.

```vexa
val name: string = "Ada"   // VexaScript
const name: string = "Ada" // TypeScript equivalent
```

### Destructuring: `::` for renaming and `:` for inline types

In VexaScript destructuring, the colon (`:`) introduces an **inline type annotation**, and the double-colon (`::`) **renames** a source property to a local binding. This is the reverse of TypeScript, where `:` renames.

```vexa
// VexaScript
let { name :: displayName, age: number } = person
//          ^^^ renames    ^^^ type annotation
```

```typescript
// TypeScript equivalent
let { name: displayName, age }: { name: string; age: number } = person
```

## Functions

### `fun` keyword

VexaScript adds `fun` as a concise alternative to `function`.

```vexa
fun add(a: number, b: number): number {
  return a + b
}
```

### `=>` shorthand for single-expression bodies

Named functions and class methods can use `=>` to return a single expression, without a block body.

```vexa
fun double(x: number): number => x * 2

class Point(val x: number, val y: number) {
  distanceTo(other: Point): number => Math.hypot(x - other.x, y - other.y)
}
```

### `sync` functions (implicit auto-await)

The `sync` modifier declares a function that behaves like `async` but **automatically awaits** any `Promise<T>` sub-expression used as a value. The return type is written without the `Promise<...>` wrapper.

```vexa
// VexaScript
sync fun loadUser(id: string): User {
  val data = fetchJson(`/users/${id}`)   // auto-awaited; data: User
  return data
}
```

```typescript
// TypeScript equivalent
async function loadUser(id: string): Promise<User> {
  const data = await fetchJson(`/users/${id}`);
  return data;
}
```

Auto-await applies at every use site: call arguments, array elements, object properties, member receivers, operands. Bare local variable reads are **not** auto-awaited—only the point where a Promise is produced.

### `go` operator (opt-out of auto-await)

Inside a `sync` function, prefix any expression with `go` to keep the `Promise<T>` value instead of awaiting it.

```vexa
sync fun demo(): void {
  val pending: Promise<User> = go fetchUser(id)  // fire-and-forget or store
  go fetchUser(id).then(process)                 // chain without awaiting
}
```

`go` is only valid inside `sync` functions and is a contextual keyword (existing `go` identifiers still work outside `sync`).

### Named arguments

Arguments can be passed by parameter name in any order, freely mixed with leading positional arguments.

```vexa
fun connect(host: string, port: number): void { }

connect(port: 8080, host: "localhost")   // reordered automatically
connect("localhost", port: 8080)          // mixed positional + named
```

TypeScript has no named-argument syntax.

### Tail lambdas and brace lambdas

A lambda can be written after the closing parenthesis of a call (or omitting the parens entirely), following the Kotlin/Swift convention.

```vexa
[1, 2, 3].map { it * 2 }
[1, 2, 3].filter { it > 1 }
[1, 2, 3].map { n: number -> n * 2 }
```

Brace lambdas are also valid anywhere an expression is accepted:

```vexa
useEffect({
  val timeout = setTimeout({
    refresh()
  }, 1000)
  return { clearTimeout(timeout) }
}, [count])
```

When a brace lambda appears as a trailing lambda or as a brace-lambda argument, the shorthand `{ body }` form gets the implicit `it` parameter. In ordinary expression positions, the same shorthand is a zero-argument lambda unless an explicit parameter list is written with `->`.

Inside an argument list, `{ name }` remains context-sensitive: it can be interpreted semantically as a one-parameter lambda (implicit `it`) when the expected parameter type is a function, and as a shorthand object literal otherwise. The explicit `{ arg -> body }` form is always a lambda.

TypeScript uses inline arrow functions: `[1,2,3].map(it => it * 2)`.

### `@JsInline` annotation

A bodyless function with `@JsInline` provides a raw JavaScript template inserted at each call site.

```vexa
@JsInline("if (!cond) throw new Error(message)")
fun assert(cond: boolean, message: string = "assert failed")

assert(value > 0)
```

### `annotation` declarations and `@JsName`

Annotations are declared explicitly and then applied with `@`:

```vexa
annotation Benchmark
annotation JsName(val name: string)
annotation JsInline(val replacement: string)
```

Zero-argument annotations may omit parentheses in both declarations and use sites:

```vexa
annotation Benchmark

@Benchmark
fun measure() {}
```

`@JsName` overrides the emitted JavaScript name while keeping the source name for VexaScript analysis.

```vexa
@JsName("rgba")
class Color(val r: int, val g: int, val b: int, val a: int)

val white = Color(255, 255, 255, 255)  // emits: new rgba(255, 255, 255, 255)
```

### Native implementation and FFI annotations

`@CppHeader`, `@CppFlags`, and `@CppBody` attach trusted C++ source and build
metadata to a signature-only function. `@FFILibrary("candidate", ...)` attaches
an ordered dynamic-library search list to an ambient class whose static methods
name C symbols. `@FFIName` optionally separates the imported symbol from the
source method name. Native builds use cached `LibraryOpen` symbol resolution;
JavaScript uses Deno FFI or a compatible `globalThis.VexaFFI` adapter. See
`docs/syntax.md` for `@FFIStruct` layouts, `FFIPointer`, asynchronous
`Promise<T>` calls, and the complete type and security contract.

## Classes

### Primary constructors

Classes can declare their constructor parameters inline after the class name (Kotlin-style). Parameters prefixed with `val`, `var`, `let`, or `const` become instance properties automatically.

```vexa
class Point(val x: number, val y: number)
class User(val name: string, var age: int = 0)
```

```typescript
// TypeScript equivalent
class Point {
  constructor(readonly x: number, readonly y: number) {}
}
```

### Optional braces for empty classes

When a class has no members (only the primary constructor or nothing), the braces can be omitted.

```vexa
class Tag
class Point(val x: number, val y: number)
```

### Class instantiation without `new`

A declared class can be called directly without `new`.

```vexa
val p = Point(1, 2)          // VexaScript
const p = new Point(1, 2);   // TypeScript equivalent
```

`new ClassName(...)` is still valid and accepted.

### Implicit `this` member access

Inside class methods and field initializers, class members can be referenced without the `this.` prefix. Local variables and parameters shadow members with the same name.

```vexa
class Counter(val value: int) {
  fun increment(amount: int): int {
    return value + amount  // emits: return this.value + amount
  }
}
```

### Explicit member kinds in classes and interfaces

Inside class and interface bodies, VexaScript also supports Kotlin/Swift-style member keywords so the declaration kind is visible at a glance. The older TypeScript-style member syntax still works, but `fun` and `val`/`var`/`let`/`const` are the preferred spellings.

```vexa
interface Shape {
  val area: number
  fun draw(ctx: CanvasCtx): void
}

class Rect {
  val width: number
  var height: number

  fun area(): number => width * height
}
```

### Operator overloads

Classes can declare operator methods with the `operator` keyword.

```vexa
class Vector(val x: number, val y: number) {
  operator+(other: Vector): Vector => Vector(x + other.x, y + other.y)
  operator*(scale: number): Vector => Vector(x * scale, y * scale)
}

val v = Vector(1, 2) + Vector(3, 4)  // calls operator+
```

Computed index access can also be overloaded. `operator[]` receives the bracket dimensions in order. `operator[]=` receives the assigned value first, followed by the dimensions, which keeps multidimensional setters consistent.

```vexa
class Array2<T>(val fallback: T) {
  operator[](x: int, y: int): T => fallback
  operator[]=(value: T, x: int, y: int): void { }
}

val array = Array2<string>("empty")
val cell = array[1, 2]
array[1, 2] = "next"
```

Variable-dimensional indexers use rest parameters:

```vexa
class MultiArray<T>(val fallback: T) {
  operator[](...dimensions: int[]): T => fallback
  operator[]=(value: T, ...dimensions: int[]): void { }
}

val item = multi[1, 2, 3]
multi[1, 2, 3] = item
```

Extension index operators can also target `Property<T>` values produced by property references:

```vexa
fun Property<number>.operator[](src: number, dst: number): TweenTarget => TweenTarget(this, src, dst)

tween(view::x[0, 100], time: 1.seconds)
```

TypeScript has no operator overloading, so equivalent code must use named methods such as `get(x, y)` and `set(value, x, y)`.

### Class interface delegates

A class can satisfy an interface by forwarding all missing members to a delegate value using `by` in the heritage clause.

```vexa
interface Drawable {
  draw(ctx: CanvasCtx): void
  bounds: Rect
}

class Widget(val shape: Drawable) : Drawable by { shape } {
  // draw() and bounds are forwarded to shape automatically
}
```

```typescript
// TypeScript equivalent (written by hand)
class Widget implements Drawable {
  constructor(private shape: Drawable) {}
  draw(ctx: CanvasCtx) { this.shape.draw(ctx); }
  get bounds() { return this.shape.bounds; }
}
```

## Extension methods and properties

Methods and read-only properties can be added to existing types without modifying their class.

```vexa
fun String.shout(): string { return this.toUpperCase() + "!" }
val number.seconds: Duration => Duration(this * 1000)

"hello".shout()   // "HELLO!"
10.seconds        // Duration(10000)
```

Extension members must be imported before use; they are not automatically in scope across files:

```vexa
import { shout } from "./stringExtensions"
"hello".shout()
```

TypeScript has no first-class extension methods; the workaround is prototype augmentation, which is unsafe and not supported in strict mode.

## Delegated variables

Variables can delegate reads and writes to an external object using `by`, inspired by Kotlin property delegates.

```vexa
fun useState(initial: number) {
  return [() => initial, (v: number) => { initial = v }]
}

var count by useState(0)
count++      // routes through the delegate setter
count += 5
```

The delegate shape determines the accessor logic:

| Delegate type | Read | Write |
|---|---|---|
| `[value, setter]` | first element | call second element |
| `[getter, setter]` | call first | call second |
| `Property<T>` from `expr::field` | `.value` getter | `.value = ...` setter |
| `{ value: T }` | `.value` | `.value = ...` |
| `() => T` | call function | — |

TypeScript has no delegated variable syntax.

### Property references

`expr::field` captures a concrete property as `Property<T>`. At runtime the receiver is evaluated once and the property reference exposes `name: string` plus a get/set `value: T` property. It is intentionally different from the `::` used inside destructuring patterns: in expression position it creates a bindable property reference, while in object binding patterns it renames a source property.

```vexa
class View(var x: number)

val view = View(0)
val property = view::x
property.value = 1
var x by property
x = 100 // writes view.x
```

TypeScript has no direct property-reference expression. The closest equivalent is hand-written getter/setter closures.

## Numeric types

VexaScript extends the TypeScript type system with explicit integer types.

| Type | Description | TypeScript equivalent |
|---|---|---|
| `int` | 32-bit integer | `number` |
| `number` | 64-bit floating-point number | `number` |
| `numeric` | common supertype of `int`/`number`/`long`/`bigint` | — |
| `long` | 64-bit signed integer | `bigint` |
| `bigint` | arbitrary-precision integer | `bigint` |

`long` literals use the `L` suffix: `10L`, `0xffL`. At runtime, `long` values are lowered to JavaScript `bigint` with 64-bit wrapping (`BigInt.asIntN(64, ...)`).

`int` expressions are wrapped with `|0` to keep the values `int32`.

```vexa
val count: int = 0
val big: long = 9_223_372_036_854_775_807L
val ratio: number = 3.14
```

## Statements

### Range expressions

Ranges are first-class expressions with inclusive (`...`) and exclusive (`..<`) variants, inspired by Swift.

```vexa
0 ... 10   // inclusive: 0 through 10
0 ..< 10   // exclusive: 0 through 9
```

Range iteration transpiles to a classic index loop:

```vexa
for (n of 0 ..< 10) console.log(n)
// emits: for (let n = 0; n < 10; n++) console.log(n)
```

TypeScript has no range syntax.

### `defer` statement

`defer expression` schedules a cleanup expression to run at the end of the current block, even if the block exits early via `return` or `throw`. Inspired by Swift and Go.

```vexa
val file = open()
defer file.close()
return file.readAll()
```

```typescript
// TypeScript equivalent
const file = open();
try {
  return file.readAll();
} finally {
  file.close();
}
```

### `for-in` / `for-of` without declaration keyword

In VexaScript mode, loop iterators do not require a declaration keyword.

```vexa
for (item of items) process(item)
for (key in map) use(key)
```

```typescript
// TypeScript
for (const item of items) process(item);
for (const key in map) use(key);
```

### `is` operator for type narrowing (smart casts)

The `is` operator checks the runtime type and narrows the compile-time type in the true branch—similar to `instanceof` but with smart-cast integration.

```vexa
if (shape is Circle) {
  shape.radius  // shape is narrowed to Circle here
}
```

```typescript
// TypeScript equivalent
if (shape instanceof Circle) {
  shape.radius;
}
```

`is` compiles to JavaScript `instanceof`.

### Cascade operator

VexaScript adds the cascade operator `..`. It evaluates a receiver once, applies each following member operation to that receiver, and returns the receiver.

```vexa
val badge = Graphics()
  ..point = Vec2(centerX, centerY - 16)
  ..beginFill(0xff6b35)
  ..endFill()
```

```typescript
// TypeScript equivalent
const badge = new Graphics();
badge.point = Vec2(centerX, centerY - 16);
badge.beginFill(0xff6b35);
badge.endFill();
```

TypeScript has no cascade operator.

## Embedded XML / JSX

In VexaScript `.vx` files, JSX is **always enabled**. A `<` in expression position starts an XML/JSX element. Consequently, the angle-bracket type cast `<Type>value` is **not available** in VexaScript—use `value as Type` instead.

```vexa
// VexaScript: JSX always on; use `as` for type casts
val name = maybeString as string
val elem = <div class="greeting">Hello {name}</div>
```

```typescript
// TypeScript: JSX opt-in (.tsx); angle-bracket cast available in .ts
const name = <string>maybeString;      // .ts only
const elem = <div className="...">…</div>; // .tsx
```

## `///` documentation comments

VexaScript uses triple-slash (`///`) single-line doc comments in addition to `/** */` block doc comments. Both are surfaced by the language server in hover and completion tooltips.

```vexa
/// Returns the distance between two points.
/// [a] and [b] must be in the same coordinate space.
fun distance(a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
```

## Runtime namespaces

VexaScript `namespace` declarations create actual JavaScript objects at runtime. Exported members become object properties; non-exported members are private to the namespace closure.

```vexa
namespace MathUtils {
  const PI = 3.14159
  export fun circleArea(r: number): number { return PI * r * r }
}

MathUtils.circleArea(5)
```

TypeScript namespaces are erased to IIFEs and are primarily a compile-time construct (their emitted objects are accessed through the same IIFE pattern, but VexaScript makes this the first-class runtime model).

## Module exports

In VexaScript `.vx` files, top-level runtime declarations are exported implicitly unless they are marked `private`, so `export` is optional for public top-level symbols:

```vexa
fun greet(name: string): string => `Hello ${name}`
private fun hidden(): string => "secret"
```

```vexa
import { greet } from "./helpers"
```

Explicit `export` is still supported and remains useful for default exports, re-exports, type-only exports, and teams that prefer the extra clarity at the declaration site.

## Comment styles

VexaScript supports three comment styles (TypeScript supports only the first two):

```vexa
// single-line comment

/// documentation comment (appears in hover/completion)

/* block comment */
```

## Semicolons

Semicolons are optional in VexaScript. Newlines act as statement separators. This is by design—not just ASI—so idiomatic VexaScript code omits semicolons.

```vexa
let a = 1
let b = 2
a += b
```
