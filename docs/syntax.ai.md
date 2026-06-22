# VexaScript for AI Agents

VexaScript (`.vx` files) is a TypeScript superset — all valid TypeScript works. This reference only lists additions and changes.

## Variables

| VexaScript | TypeScript | Notes |
|---|---|---|
| `val x: T = v` | `const x: T = v` | immutable; prefer `val` |
| `var x: T = v` | `let x: T = v` | mutable |

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

## Classes

```vexa
class Point(val x: number, val y: number)  // primary constructor; val/var params become properties
val p = Point(1, 2)                         // no `new` needed (new still works)
```

Inside methods, `this.` is implicit — write `x` instead of `this.x`.

```vexa
class Rect(val w: number, val h: number) {
  fun area(): number => w * h
  operator*(scale: number): Rect => Rect(w * scale, h * scale)
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

defer file.close()                 // runs at block exit, like finally

if (x is Circle) { x.radius }     // smart cast; compiles to instanceof
```

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
- Runtime namespaces: `namespace Foo { export fun bar() {} }` creates a real JS object.
- Delegated variables: `var count by useState(0)` routes reads/writes through the delegate.
