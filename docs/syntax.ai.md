# VexaScript for AI Agents

VexaScript (`.vx` files) is derived from TypeScript and keeps its ecosystem, with the deliberate syntax differences below.

## Character and string literals

- `"text"` is a `string`.
- `'a'` is the `int` Unicode code point `97`; `'😀'` is `128512`.
- Single quotes must contain exactly one decoded code point. `'aaa'` and `''` are errors; use `"aaa"` (the editor offers a quick fix).
- Character literals emit as direct integer constants in JavaScript and C++.
- TypeScript mode is unchanged: single quotes remain strings in `.ts`, `.tsx`, and `.d.ts`.

```vexa
val matches = "aaa".charCodeAt(0) == 'a'
```

Backtick templates accept both `${expression}` and `$identifier`; use `\$` for
a literal dollar sign.

## Variables

| VexaScript | TypeScript | Notes |
|---|---|---|
| `val x: T = v` | `const x: T = v` | immutable; prefer `val` |
| `var x: T = v` | `let x: T = v` | mutable |
| `var! x: T` | `let x!: T` (approx.) | unchecked initialization escape hatch; emits no default value |

Rules: `val`/`const` require an initializer (or `by` delegate) at the
declaration. `var x: T` may omit it, but every path must assign `x` before a
read. Use `var! x: T` only when external code guarantees initialization and the
compiler cannot prove it.

Destructuring: `:` = type annotation, `::` = rename (reversed from TS):

```vexa
let { name :: alias, age: number } = obj
```

Property references: `expr::field` captures a bindable `Property<T>` for the field. The receiver is evaluated once, and the emitted value has `name: string` plus a get/set `value: T` property compatible with `by`.

```vexa
val property = view::x
property.value = 1
var x by property
tween(view::x[0, 100], time: 1.seconds) // if Property<number>.operator[] is defined
```

## Functions

```vexa
fun add(a: number, b: number): number { return a + b }   // prefer over `function`
fun double(x: number): number => x * 2                    // single-expression shorthand
```

`sync` (auto-await): like `async` but every Promise used as a value is automatically awaited; return type is `T`, not `Promise<T>`.

```vexa
sync fun load(id: string): User {
  val data = fetchJson(`/users/${id}`)  // auto-awaited
  return data
}
```

Use `go expr` inside `sync` to keep a Promise unawaited: `val p: Promise<User> = go fetchUser(id)`.

In `.vx` files, public top-level runtime declarations are exported implicitly unless marked `private`, so `export` is optional for normal module symbols.

**Named arguments:** `connect(port: 8080, host: "localhost")`

**Tail lambdas:**

```vexa
list.map { it * 2 }               // implicit `it` parameter
list.map { n: number -> n * 2 }   // explicit parameter
useEffect({
  val timeout = setTimeout({
    count++
  }, 1000)
  return { clearTimeout(timeout) }
}, [count])                       // brace lambdas also work in expression position
```

Trailing lambdas and brace-lambda call arguments use implicit `it` for `{ expr }`. In ordinary expression positions, `{ ... }` is a zero-argument brace lambda unless it is resolved contextually as an object literal or has an explicit `->` parameter list.

Receiver function types use `T.(args) -> R`. The receiver is the first runtime
argument but is implicit inside a contextually typed lambda: unqualified members
and `this` refer to it. If visible parameters exist, `it` is the first one; for
`T.() -> R`, `it` aliases the receiver. Use `this@functionName` for a labeled
outer receiver. `value. { ... }` evaluates `value` once, runs a receiver block,
and returns that same value; it does not call `apply`. `value?. { ... }` uses the
same receiver block but skips it and returns `undefined` when `value` is
`null` or `undefined`; inside that block the receiver is narrowed to its
non-nullish type. Extension methods follow the same rule: `value?.method(args)`
guards the extension call, and `value!.method(args)` resolves it against the
non-nullish receiver.

## Classes

```vexa
class Point(val x: number, val y: number)  // primary constructor; val/var params become properties
val p = Point(1, 2)                         // no `new` needed (new still works)
```

Inside methods, `this.` is implicit — write `x` instead of `this.x`.

Class `val` fields require in-situ initialization. Class `var` fields must be
assigned before use and may be assigned in `init` blocks:

```vexa
class Counter {
  val step = 1
  var value: int
  init { value = step }
}
```

Multiple instance `init` blocks run in source order after field and primary
constructor initialization and before an explicit constructor body. `var!`
also opts a class field out of definite-assignment checking.

```vexa
class Rect(val w: number, val h: number) {
  fun area(): number => w * h
  operator*(scale: number): Rect => Rect(w * scale, h * scale)
}
```

Annotations can precede class fields, accessors, and methods as well as top-level
declarations. Compound accessors write the property once:

```vexa
class Counter {
  private var stored = 0
  var value: int {
    get { return stored }
    set(next) { stored = next }
  }
}
```

Operator overloads use `operator` methods. Binary operators receive the right-hand operand. Index getter operators receive all bracket dimensions. Index setter operators receive the assigned value first, then the bracket dimensions; rest parameters support variable-dimensional indexers.

```vexa
class Array2<T>(val fallback: T) {
  operator[](x: int, y: int): T => fallback
  operator[]=(value: T, x: int, y: int): void { }
}

class MultiArray<T>(val fallback: T) {
  operator[](...dimensions: int[]): T => fallback
  operator[]=(value: T, ...dimensions: int[]): void { }
}

val cell = array[1, 2]
array[1, 2] = "next"
```

`a <=> b` returns negative/zero/positive. `operator<=>` can derive `<`, `<=`,
`>`, and `>=` when no direct overload exists; `operator==` derives `!=`.
Ordering is an error when no primitive ordering or applicable overload exists.

Extension index operators may target `Property<T>`:

```vexa
fun Property<number>.operator[](src: number, dst: number): TweenTarget => TweenTarget(this, src, dst)
```

Interface delegation via `by`:

```vexa
class Widget(val d: Drawable) : Drawable by { d }
```

## Extension members

```vexa
fun String.shout(): string => this.toUpperCase() + "!"
val number.seconds: Duration => Duration(this * 1000)
```

Must be imported before use.

## Numeric types

| Type | Description | TS equivalent |
|---|---|---|
| `int` | 32-bit integer, wrapped with `\|0` | `number` |
| `number` | 64-bit float | `number` |
| `long` | 64-bit signed int; literal suffix `L` | `bigint` |
| `numeric` | supertype of all numeric types | — |

## Statements

```vexa
for (item of items) { }           // no declaration keyword needed
for (key in map) { }

for (n of 0 ..< 10) { }           // exclusive range → for (let n = 0; n < 10; n++)
for (n of 0 ... 10) { }           // inclusive range (0 through 10)

val doubled = [for (item of items) item * 2] // fresh inferred array; `of` visits values
val normal = [for (n in 0 ..< 10) n]        // `in` also visits values; ranges are iterable
val labels = [for (val [name, score] of entries) "$name:$score"]

defer file.close()                 // runs at block exit, like finally

if (x is Circle) { x.radius }      // basic `is` is instanceof; both smart-cast
```

Array-comprehension grammar: `[` `for` `(` iterator (`of` | `in`) iterable
`)` result-expression `]`. It supports one loop header and one expression;
classic `for` headers, statement bodies, and `for await` are invalid.

`if` is also an expression. A braced branch yields its last expression, a
missing `else` adds `undefined`, and `return`/`throw`/`break`/`continue` can be
used as `never`-typed expressions.

`is` additionally accepts built-in patterns: primitive types, literals,
objects, exact arrays, one standalone `...` array wildcard, `and`, `or`,
relational patterns, and regex literals. `string`, `number`/`int`, `boolean`,
and `bigint`/`long` lower to runtime primitive-kind checks; class names keep
`instanceof` semantics. Regex patterns only match strings and allow no flags or
`g`/`i`. Successful checks narrow the subject; custom matchers are not
supported.

```vexa
if (result is ({ kind: "ok" } and { payload })) {
  val kind: "ok" = result.kind
}
if (score is (>= 10 and < 20)) { use(score) }
if (path is /^\/users\/[0-9]+$/i) { val text: string = path }
```

`match` is an expression with ordered arms and optional subject. With `->`, omit
`when`; with `:`, `when` is mandatory. `else` and `default` are equivalent. A
braced arm yields its last expression without `do`, and the subject is evaluated
once with narrowed types available inside successful arms.

```vexa
val label = match {
  ready -> "ready"
  when retrying: "retrying"
  else -> "idle"
}

val result = match (value) {
  { kind: "ok", payload: val payload } -> payload
  [string, val count: number, ...] -> "count=" + count
  ["start", ..., "end"] -> "framed"
  when /^error:/i: "error"
  default -> "other"
}
```

In subject arms, `val name` captures with the inferred narrowed type and
`val name: Type` checks then captures that primitive or class type. Bindings are
arm-local and may be nested in arrays or object property values. `is` does not
introduce bindings. Computed object keys, object rest, array rest bindings such
as `...tail`, and custom matcher protocols are unsupported.

## Cascade operator

`..` is a cascade operator: it evaluates a receiver once, applies following member operations to that same receiver, and returns the receiver.

```vexa
val badge = Graphics()
  ..point = Vec2(centerX, centerY - 16)
  ..beginFill(0xff6b35)
  ..endFill()
```

## JSX / type casts

JSX is always enabled in `.vx` files. Use `value as Type` for casts — `<Type>value` is **not valid** in `.vx`.

## Comments

```vexa
// single-line
/// doc comment — shown in editor hover and completion tooltips
/* block */
```

## Conventions

- Semicolons are optional; idiomatic VexaScript omits them.
- Prefer `val` over `const`, `fun` over `function`.
- Annotations: `annotation Benchmark` / `@Benchmark fun measure() {}`
- `@JsName("jsName")` overrides the emitted JavaScript identifier.
- `@JsInline("js template")` inlines raw JS at each call site.
- Native/FFI declarations use `@CppHeader`, `@CppFlags`, `@CppBody`,
  `@FFILibrary`, `@FFIName`, and `@FFIStruct`; consult `docs/syntax.md` for the
  ABI and security contract.
- Runtime namespaces: `namespace Foo { export fun bar() {} }` creates a real JS object.
- `vexa test` discovers `.test.vx`; `test("name") { ... }` and strict
  `assert(condition)` are available without imports.
- Local `.ts`, `.tsx`, `.json`, and `.txt` files can be imported. Add `?text` to
  load any local file through one default string binding in JS and C++.
- Delegated variables: `var count by useState(0)` routes reads/writes through the delegate.
