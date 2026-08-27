# VexaScript vs TypeScript: Syntax Differences

This document summarises the syntax additions and differences that VexaScript introduces on top of TypeScript. Everything valid in TypeScript that is not overridden here continues to work the same way.

## Character and string literals

As in TypeScript, single and double quotes both denote strings. VexaScript adds
a `#` prefix that turns either quoted form into an integer Unicode code point:

```vexa
val text: string = 'aaa'
val letter: int = #'a' // 97
val emoji: int = #"😀" // 128512
val newline: int = #'\n' // 10
val matches = 'A'.charCodeAt(0) == #'A'

match (str.codePointAt(0)) {
  #'\n' -> handleNewline()
  else -> handleOther()
}
```

A `#`-prefixed literal must contain exactly one decoded Unicode code point.
`#'aaa'` and `#""` are errors; the editor quick fix removes the prefix and
converts the value to a string. Character literals emit as direct integer
constants in JavaScript, avoiding one-character string allocation. The
prefix is VexaScript-only; TypeScript quote behavior remains unchanged.

### String-template shorthand

Backtick templates accept both the JavaScript-compatible `${expression}` form
and a compact `$identifier` form. Escape a literal dollar sign as `\$`.

```vexa
val name = "Ada"
val greeting = `Hello $name; next year you are ${age + 1}`
```

TypeScript requires `${name}` for the first interpolation.

## Variable declarations

### Immutable declaration aliases

VexaScript accepts both `const` and `val` for immutable bindings. `val` is an
exact alias, while `const` is the default canonical spelling.

```vexa
const name: string = "Ada" // default VexaScript and TypeScript spelling
val alias: string = "Ada"  // equivalent VexaScript alias
```

Unlike TypeScript's broadly permissive local declaration rules, VexaScript
requires every `val` to be initialized in situ and checks that an uninitialized
local `var` is assigned on every path before it is read. A class `var` must also
be assigned by a field initializer, `init` block, or constructor on every path
before construction completes, even when the field is never read. The compound
keyword `var!` is the explicit escape hatch for initialization performed by
code the compiler cannot observe:

```vexa
var value: int
if (ready) { value = 1 } else { value = 2 }
consume(value)

var! externallyInjected: Service

class Injected {
  var! service: Service
}
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

### Function declaration aliases

VexaScript accepts `func`, `fn`, and `fun` as concise alternatives to
`function`. `func` is the default canonical spelling.

```vexa
func add(a: number, b: number): number {
  return a + b
}

fn subtract(a: number, b: number): number => a - b
fun legacyAlias(): void {}
```

Normalization quick fixes use `const` and `func` by default. The nearest
`vexascript.json` can override either choice:

```json
{
  "canonicalSyntax": {
    "immutableDeclaration": "val",
    "functionDeclaration": "fn"
  }
}
```

### `=>` shorthand for single-expression bodies

Named functions and class methods can use `=>` to return a single expression, without a block body.

```vexa
func double(x: number): number => x * 2

class Point(const x: number, const y: number) {
  distanceTo(other: Point): number => Math.hypot(x - other.x, y - other.y)
}
```

### `sync` functions (implicit auto-await)

The `sync` modifier declares a function that behaves like `async` but **automatically awaits** any `Promise<T>` sub-expression used as a value. The return type is written without the `Promise<...>` wrapper.

```vexa
// VexaScript
sync func loadUser(id: string): User {
  const data = fetchJson(`/users/${id}`) // auto-awaited; data: User
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
tasks.map() async { await run(it) }
tasks.map() sync { run(it) }
tasks.map(async { await run(it) })
tasks.map(sync { run(it) })
```

For a modified brace lambda, `async` or `sync` is written immediately before `{`, whether the lambda is trailing or remains inside the argument list. The modifier belongs to the lambda. `async` keeps TypeScript-style explicit `await`; `sync` enables VexaScript auto-await inside the callback. The trailing-lambda quick fix preserves the modifier when moving an argument-list lambda outside. TypeScript requires an arrow callback such as `tasks.map(async it => await run(it))`.

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

Object spread follows TypeScript compatibility rules for dynamic values:
`{ ...value }` accepts `value: any` (as well as object-shaped and unknown
values), while a statically known primitive spread is diagnosed.

TypeScript uses inline arrow functions: `[1,2,3].map(it => it * 2)`.

### Receiver function types and blocks

A function type can declare an implicit receiver before its parameters:

```vexa
fun <T> T.configure(block: T.() -> void): T {
  block(this)
  return this
}

val point = Point(1, 2).configure {
  x *= 2
  y += x
}
```

`T.(arg: A) -> R` is represented at runtime as `(T, A) -> R`, so a direct call
passes the receiver first. Inside a contextually typed brace lambda, unqualified
members and `this` refer to the receiver. Implicit `it` is the first visible
parameter when one exists; for `T.() -> R`, it aliases the receiver. Nested
receivers can be selected explicitly with `this@functionName`.

Optional and non-null asserted member access use the same extension-method
resolution as ordinary member access. `value?.method(args)` guards the
extension call for a nullish receiver, while `value!.method(args)` resolves it
after removing nullish types.

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
annotation JsName(const name: string)
annotation JsInline(const replacement: string)
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

Annotations may also be attached directly to class fields, accessors, and
methods. Their arguments are checked like top-level annotation applications and
the annotations themselves are erased unless a compiler-recognized annotation
defines lowering behavior.

### JavaScript FFI annotations

`@FFILibrary("candidate", ...)` attaches
an ordered dynamic-library search list to an ambient class whose static methods
name C symbols. `@FFIName` optionally separates the imported symbol from the
source method name. JavaScript uses Deno FFI or a compatible
`globalThis.VexaFFI` adapter. See
`docs/syntax.md` for `@FFIStruct` layouts, `FFIPointer`, asynchronous
`Promise<T>` calls, and the complete type and security contract.

### Test files

`vexa test` discovers `.test.vx` files and supplies Node-compatible `test` and
strict `assert` helpers without imports:

```vexa
test("arithmetic") {
  assert(1 + 1 == 2)
}
```

The test name is reported by Node's test runner, and runner flags can be passed
through the CLI.

## Classes

### Primary constructors

Classes can declare their constructor parameters inline after the class name (Kotlin-style). Parameters prefixed with `val`, `var`, `let`, or `const` become instance properties automatically.

```vexa
class Point(val x: number, val y: number)
class User(val name: string, var age: int = 0)
```

Primary-constructor parameters can be forwarded directly to a base constructor.
The colon form and the canonical `extends` form are equivalent:

```vexa
abstract class Entity(val id: int)
class User(id: int, val name: string) : Entity(id)
// formatted as: class User(const id: int, val name: string) extends Entity(id)
```

The arguments are type-checked against the base constructor and execute before
derived property initialization. An abstract class itself cannot be constructed
with either `Entity(...)` or `new Entity(...)`; instantiate a concrete subclass.

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

VexaScript also checks each class-field initializer against its explicit field
type. Its distinct `int` type therefore rejects fractional `number` values:

```vexa
class Invalid {
  var count: int = 0.5 // error
}
```

### Implicit `this` member access

Inside class methods and field initializers, class members can be referenced without the `this.` prefix. Local variables and parameters shadow members with the same name.

```vexa
class Counter(val value: int) {
  fun increment(amount: int): int {
    return value + amount  // emits: return this.value + amount
  }
}
```

### Instance initialization blocks

VexaScript classes support Kotlin-style `init { }` blocks, which TypeScript
does not have. Multiple blocks run once per instance in source order, after
field/primary-constructor initialization and before the explicit constructor
body. Class `val` fields still require an in-situ initializer; mutable `var`
fields can be initialized in these blocks.

```vexa
class Counter {
  val step = 1
  var value: int

  init {
    value = step
  }
}
```

JavaScript emission folds these statements into an instance constructor.

### Explicit member kinds in classes and interfaces

Inside class and interface bodies, VexaScript also supports explicit member keywords so the declaration kind is visible at a glance. The older TypeScript-style member syntax still works; `func` and `const`/`var` are canonical by default, while `fn`, `fun`, `function`, `val`, and `let` remain supported.

```vexa
interface Shape {
  const area: number
  func draw(ctx: CanvasCtx): void
}

class Rect {
  const width: number
  var height: number

  func area(): number => width * height
}
```

### Compound accessor blocks

A property may group its getter and setter under one declaration. The default
setter parameter is `newValue`; `set(name)` or `set(name: Type)` overrides it.
The order of `get` and `set` does not matter.

```vexa
class Counter {
  private var stored = 0

  var value: int {
    get { return stored }
    set(next) { stored = next }
  }
}
```

The form lowers through the shared JavaScript property-accessor path.

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

VexaScript also supports the three-way comparison operator `<=>`. Primitive
numbers, big integers, strings, and characters produce a negative value, zero,
or a positive value. Classes and extensions may declare `operator<=>`; when a
direct `<`, `<=`, `>`, or `>=` overload is absent, those comparisons are derived
from its result. An `operator==` overload similarly derives `!=` as its
negation. Ordering operators are rejected when neither a primitive ordering nor
an applicable direct or spaceship overload is defined.

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

## Nullable types

VexaScript accepts `T?` as shorthand for `T | undefined` in every type position,
including nested generic arguments and explicit generic calls:

```vexa
let users: User?[] = []
const context = createContext<User?>(undefined)
```

This suffix does not add `null`; write `T | null` or `T | null | undefined`
when those values are part of the type.

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

VexaScript also selects asynchronous iteration from the source type. A class or
interface with `[Symbol.asyncIterator]()` can be used in the ordinary
declaration-free loop form, and the compiler emits JavaScript `for await...of`.
TypeScript normally spells that choice explicitly as `for await (const item of
items)`. A `for-of` source with neither `Symbol.iterator` nor
`Symbol.asyncIterator` is a type error; the diagnostic points at that source
expression in the loop header.

The return annotation on a VexaScript generator protocol method is optional.
For example, `sync *[Symbol.asyncIterator]()` with `yield 1` is inferred as
returning `AsyncGenerator<int>`, and an ordinary `for (item of source)` infers
`item` as `int`. The protocol resolver uses that yield-derived method type; it
does not require a repeated explicit `AsyncGenerator<T>` annotation.

If the annotation is present, VexaScript checks each `yield` against the
declared generator element type. Thus `(): AsyncGenerator<int>` followed by
`yield "text"` is an error on `"text"`; the shorthand `(): int` has the same
element constraint. Delegated `yield*` expressions are checked by their source
element type, including when the source is another generator whose return type
is inferred. Direct and mutually recursive generator dependencies use bounded
fixed-point inference, so cycles terminate while propagating all known yielded
types.

### Array comprehensions

VexaScript can collect a loop expression directly into a new array. TypeScript
requires an explicit array operation or loop instead.

```vexa
val doubled = [for (value of values) value * 2]
val normal = [for (n in 0 ..< 10) n]
val labels = [for (val [name, score] of entries) "$name:$score"]
val transformed = [for (n in 0 ... 9) if (n % 2 == 0) n else n * 3]
val optional = [for (n in 0 ... 9) if (n % 2 == 0) n]
val mixed = [1, for (n in 0 ... 9) n, ...items, for (n in 0 ... 9) n * 2, 0]
val conditionalMixed = [
  for (n in 0 ... 9) if (n % 2 == 0) n else n * 3,
  for (n in 0 ... 9) if (n % 2 == 0) n,
]
```

```typescript
const doubled = Array.from(values, value => value * 2);
const normal = Array.from({ length: 10 }, (_, n) => n);
const labels = Array.from(entries, ([name, score]) => `${name}:${score}`);
const transformed = Array.from(range(0, 9), n => n % 2 === 0 ? n : n * 3);
const optional = Array.from(range(0, 9)).filter(n => n % 2 === 0);
const mixed = [1, ...range(0, 9), ...items, ...range(0, 9).map(n => n * 2), 0];
```

Inside an array comprehension, both `in` and `of` collect iterable values,
including values from inclusive and exclusive ranges. Comprehension `in`
follows declaration-free VexaScript loop semantics rather than JavaScript and
TypeScript object-key iteration. The single expression body determines the
result array's element type. Comprehensions can be interleaved with normal array
elements and spreads; each comprehension contributes all of its generated
values in place without requiring an explicit `...`. An `if` expression may be
the result expression. If a top-level result `if` omits `else`, it acts as a
filter: false iterations append nothing, and the true branch determines the
element type. Separating and trailing commas work normally when comprehensions
are array elements, even when the array begins with a conditional
comprehension.

VexaScript also allows an unbraced `if` without `else` as an element of an
ordinary array literal. It conditionally contributes one element, equivalent to
`...(if (condition) [value] else [])`. The comma after the branch separates
array elements; an intentional comma expression must be parenthesized, such as
`[(a, b)]`.

### `is` nominal checks and built-in matcher patterns

The basic `value is ClassName` form remains VexaScript's shorter spelling of
`instanceof`. Both spellings perform the same nominal runtime check and narrow
stable identifiers and member expressions.

```vexa
if (shape is Circle) {
  shape.radius  // shape is narrowed to Circle here
}

// `instanceof` has the same smart-cast behavior
if (shape instanceof Circle) {
  shape.radius  // shape is narrowed to Circle here too
}
```

```typescript
// TypeScript equivalent
if (shape instanceof Circle) {
  shape.radius;
}
```

Unlike `instanceof`, `is` additionally accepts built-in patterns:

```vexa
if (result is ({ kind: "ok" } and { payload })) {
  val kind: "ok" = result.kind
}

if (temperature is (>= 10 and < 20)) { log("mild") }
if (parts is ["start", ..., "end"]) { log("framed") }
if (path is /^\/users\/[0-9]+$/i) {
  val text: string = path
}
```

Supported built-ins are primitive type tests, literal equality, object property
patterns, exact arrays, one standalone non-binding `...` array wildcard,
relational patterns, `and`/`or`, and regular-expression literals. Primitive
patterns (`string`, `number`/`int`, `boolean`, and `bigint`/`long`) lower to
`typeof` rather than `instanceof`; class names remain nominal. Regex patterns
only match strings and accept no flags or the portable `g`/`i` flags. Computed
keys, object rest, array rest bindings, and custom matcher protocols are not
supported. Subjects and recursively inspected values are evaluated once.

### `if` and abrupt control flow as expressions

In VexaScript, `if` is an expression. A braced branch evaluates to its final
expression statement, an omitted `else` contributes `undefined`, and a branch
ending in `return`, `throw`, `break`, or `continue` has type `never` rather than
widening the reachable result.

```vexa
val label = if (ready) "ready" else {
  prepare()
  "prepared"
}

val value = input ?? return fallback
```

The abrupt forms `return`, `throw`, `break`, and `continue` can appear wherever
an expression is accepted in `.vx` files. TypeScript keeps these forms
statement-only.

### Match expressions

`match` is an expression lowered to a typed `if`/`else` representation in
JavaScript. Arms are ordered and braced bodies evaluate to their final
expression without a `do` keyword.

```vexa
val label = match {
  ready -> "ready"                 // `->` omits `when`
  when retrying: "retrying"        // `:` requires `when`
  else -> "idle"
}

val result = match (value) {
  { kind: "ok", payload: val payload } -> payload
  [string, val count: number, ...] -> "count=" + count
  when /^error:/i: "error"
  default -> "other"
}
```

Writing `when condition -> body` or `condition: body` is an error. `else` and
`default` are equivalent. A subject is evaluated once, and subject arms accept
the same built-in patterns as `is`, including `>= 10 and < 20`, objects, arrays,
the standalone `...` wildcard, and regex literals. Successful arms preserve
their narrowed subject types; later arms retain only exclusions that are
logically definite.

Only subject `match` arms introduce bindings. `val name` captures with its
inferred narrowed type, while `val name: Type` checks that primitive or class
type and captures it. The name is scoped to that arm. Boolean `is` patterns
narrow existing values but do not declare bindings.

### Postfix receiver blocks

The postfix form `value. { ... }` evaluates `value` once, makes it the implicit
receiver inside the block, and returns the same value. It is useful for grouped
configuration and mutation without introducing a temporary variable or an
`apply` helper.

```vexa
val point = Point(10, 20). {
  x *= 2
  y += x / 2
}
```

VexaScript also supports `value?. { ... }`. This form evaluates `value` once,
executes the receiver block only when the value is not `null` or `undefined`,
and returns `undefined` for a nullish value. The block's receiver is narrowed to
the non-nullish type:

```vexa
canvas.getContext("2d")?. {
  fillStyle = "#f4f8fc"
}
```

Inside the block, `x` and `y` resolve against the `Point` receiver. The complete
expression still evaluates to that same `Point` instance. JavaScript emits the
receiver block directly at the use site.

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

Unlike TSX attribute syntax, VexaScript permits an empty JSX expression
container. `{}` means `undefined`, so `<button onAbort={} style={styles} />`
parses and emits exactly as if `onAbort={undefined}` had been written; the
following `style` attribute remains a separate, normally parsed attribute.
Empty child containers likewise contribute `undefined`.

VexaScript also extends JSX child lists with Svelte-style control blocks. These
are not TypeScript/TSX syntax: `{#for item of items}...{/for}` produces a child
array, while `{#if condition}...{:else if other}...{:else}...{/if}` selects one
child sequence and yields `null` when no branch matches and no else is present.

```vexa
<ul>
  {#for item of items}
    {#if item.visible}<li>{item.name}</li>{/if}
  {/for}
</ul>
```

Component tags remain classic-factory calls. `<MyComponent/>` passes the
component reference to `React.createElement` (or the configured factory); a
renderer or an eager custom factory is responsible for invoking it.

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

## Module imports

In addition to `.vx`, local runtime imports may target `.ts`, `.tsx`, `.json`,
and `.txt`. Appending `?text` loads any local file as a string in JavaScript:

```vexa
import declarationSource from "./runtime.d.ts?text"
```

Text-module imports require exactly one default binding.

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
