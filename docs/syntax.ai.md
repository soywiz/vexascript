# VexaScript for AI Agents

VexaScript (`.vx` files) is derived from TypeScript and keeps its ecosystem, with the deliberate syntax differences below.

## Character and string literals

- `"text"` and `'text'` are both `string` values.
- Prefix either quote style with `#` for an `int` Unicode code point: `#'a'` is `97`, `#"😀"` is `128512`, and `#'\n'` is `10`.
- A `#`-prefixed quoted literal must contain exactly one decoded code point. `#'aaa'` and `#""` are errors; remove `#` for a string (the editor offers a quick fix).
- Character literals emit as direct integer constants in JavaScript and C++.
- The `#` prefix is VexaScript-only. TypeScript mode keeps its normal single- and double-quoted strings.

```vexa
const matches = 'A'.charCodeAt(0) == #'A'

match (str.codePointAt(0)) {
  #'\n' -> handleNewline()
  else -> handleOther()
}
```

Backtick templates accept both `${expression}` and `$identifier`; use `\$` for
a literal dollar sign.

## Variables

| VexaScript | TypeScript | Notes |
|---|---|---|
| `const x: T = v` | `const x: T = v` | immutable; canonical by default |
| `val x: T = v` | `const x: T = v` | exact immutable alias |
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
const property = view::x
property.value = 1
var x by property
tween(view::x[0, 100], time: 1.seconds) // if Property<number>.operator[] is defined
```

## Functions

```vexa
func add(a: number, b: number): number { return a + b }  // canonical by default
fn double(x: number): number => x * 2                    // supported alias
fun legacy(): void {}                                    // supported alias
function tsStyle(): void {}                              // supported alias
```

Canonical spelling configuration (editor normalization and generated fixes):

```json
{
  "canonicalSyntax": {
    "immutableDeclaration": "const",
    "functionDeclaration": "func"
  }
}
```

`immutableDeclaration`: `"const" | "val"` (default `"const"`).
`functionDeclaration`: `"func" | "fn" | "fun" | "function"` (default
`"func"`). All aliases remain parseable regardless of this setting.

`sync` (auto-await): like `async` but every Promise used as a value is automatically awaited; return type is `T`, not `Promise<T>`.

```vexa
sync func load(id: string): User {
  const data = fetchJson(`/users/${id}`)  // auto-awaited
  return data
}
```

Use `go expr` inside `sync` to keep a Promise unawaited: `const p: Promise<User> = go fetchUser(id)`.

In `.vx` files, public top-level runtime declarations are exported implicitly unless marked `private`, so `export` is optional for normal module symbols.

**Named arguments:** `connect(port: 8080, host: "localhost")`

**Tail lambdas:**

```vexa
list.map { it * 2 }               // implicit `it` parameter
list.map { n: number -> n * 2 }   // explicit parameter
task.run("demo") async { await work(it) }
task.run("demo") sync { work(it) }
task.run("demo", async { await work(it) })
task.run("demo", sync { work(it) })
useEffect({
  const timeout = setTimeout({
    count++
  }, 1000)
  return { clearTimeout(timeout) }
}, [count])                       // brace lambdas also work in expression position
```

Trailing lambdas and brace-lambda call arguments use implicit `it` for `{ expr }`. In ordinary expression positions, `{ ... }` is a zero-argument brace lambda unless it is resolved contextually as an object literal or has an explicit `->` parameter list.

Modified brace-lambda grammar: `call(args) (async | sync) { body }` or `call(args, (async | sync) { body })`. The modifier applies to the lambda. `async` requires explicit `await`; `sync` enables implicit auto-await. Both emit JavaScript `async` callbacks. Moving the lambda outside the argument list must preserve its modifier.

Object literals may spread `any`, `unknown`, `object`, and object-shaped values:
`{ ...args, children }`. Reject spreads whose type is a known primitive.

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
class Point(const x: number, const y: number) // primary constructor; declaration params become properties
const p = Point(1, 2)                        // no `new` needed (new still works)
```

Forward base-constructor arguments in the class heritage clause. Arguments are
resolved in the primary-constructor parameter scope, checked against the base
constructor, and evaluated before derived property and `init` initialization:

```vexa
abstract class Entity(val id: int)
class User(id: int, val name: string) : Entity(id)
// Canonical formatter output uses: extends Entity(id)
```

Never instantiate an abstract class directly. Both `Entity(...)` and
`new Entity(...)` are errors; construction is valid only through a concrete
subclass.

Inside methods, `this.` is implicit — write `x` instead of `this.x`.

Class `const`/`val` fields require in-situ initialization. Class `var` fields
must be assigned on every path before construction completes, using a field
initializer, an `init` block, or the constructor. Report an error for an
unassigned class `var` even when the field is never read:

```vexa
class Counter {
  const step = 1
  var value: int
  init { value = step }
}
```

Multiple instance `init` blocks run in source order after field and primary
constructor initialization and before an explicit constructor body. `var!`
is one compound declaration keyword and opts a class field out of
end-of-construction and use-before-initialization checking.

If a class field has an explicit type and an initializer, require the
initializer type to be assignable to the field type. Example:

```vexa
class Invalid { var count: int = 0.5 } // error: number is not assignable to int
```

```vexa
class Rect(const w: number, const h: number) {
  func area(): number => w * h
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
class Array2<T>(const fallback: T) {
  operator[](x: int, y: int): T => fallback
  operator[]=(value: T, x: int, y: int): void { }
}

class MultiArray<T>(const fallback: T) {
  operator[](...dimensions: int[]): T => fallback
  operator[]=(value: T, ...dimensions: int[]): void { }
}

const cell = array[1, 2]
array[1, 2] = "next"
```

`a <=> b` returns negative/zero/positive. `operator<=>` can derive `<`, `<=`,
`>`, and `>=` when no direct overload exists; `operator==` derives `!=`.
Ordering is an error when no primitive ordering or applicable overload exists.

Extension index operators may target `Property<T>`:

```vexa
func Property<number>.operator[](src: number, dst: number): TweenTarget => TweenTarget(this, src, dst)
```

Interface delegation via `by`:

```vexa
class Widget(const d: Drawable) : Drawable by { d }
```

## Extension members

```vexa
func String.shout(): string => this.toUpperCase() + "!"
const number.seconds: Duration => Duration(this * 1000)
```

Must be imported before use.

## Nullable types

`T?` in a type position means exactly `T | undefined`; it is valid in nested
type forms and generic arguments such as `T?[]`, `Context<User?>`, and
`createContext<User?>(undefined)`. It does not include `null`.

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

// A source with [Symbol.asyncIterator](): AsyncIterator<T> or AsyncGenerator<T>
// makes the ordinary loop emit `for await...of`; item is inferred as T.
for (item of asyncSource) { }

// Generator return annotations are optional. Infer T from yield expressions,
// including computed protocol methods, then propagate T to the loop variable.
class Stream {
  sync *[Symbol.asyncIterator]() { yield 1 } // AsyncGenerator<int>
}
for (item of Stream()) { } // item: int

// An explicit generator return constrains every yielded element. Accept both
// wrapper and shorthand annotations; range mismatches over the yielded value.
sync fun * ints(): AsyncGenerator<int> {
  yield 1
  yield "bad" // error: string is not assignable to int
}

// `yield*` uses the delegated generator's inferred element type. Resolve
// direct and mutual generator recursion with a bounded fixed point.
sync fun * mixed() {
  yield "bad"
  yield* mixed()
}
sync fun * delegatedInts(): AsyncGenerator<int> {
  yield* mixed() // error: string is not assignable to int
}

const doubled = [for (item of items) item * 2] // fresh inferred array; `of` visits values
const normal = [for (n in 0 ..< 10) n]        // `in` also visits values; ranges are iterable
const labels = [for (const [name, score] of entries) "$name:$score"]
const transformed = [for (n in 0 ... 9) if (n % 2 == 0) n else n * 3]
const optional = [for (n in 0 ... 9) if (n % 2 == 0) n] // false iterations are omitted
const mixed = [1, for (n in 0 ... 9) n, ...items, for (n in 0 ... 9) n * 2, 0]
const conditionalMixed = [
  for (n in 0 ... 9) if (n % 2 == 0) n else n * 3,
  for (n in 0 ... 9) if (n % 2 == 0) n,
]

defer file.close()                 // runs at block exit, like finally

if (x is Circle) { x.radius }      // basic `is` is instanceof; both smart-cast
```

`for-of` statement sources must be iterable. Accept synchronous
`[Symbol.iterator]()` and asynchronous `[Symbol.asyncIterator]()` protocols;
for an asynchronous source, emit `for await...of` automatically. If neither
protocol applies, report the error on the source expression after `of`. Do not
invent iterability from the class name or unrelated members. Keep `for-in`
object-key behavior separate from this `for-of` validation.

Array-comprehension grammar: `[` `for` `(` iterator (`of` | `in`) iterable
`)` result-expression `]`. It supports one loop header and one expression;
classic `for` headers, statement bodies, and `for await` are invalid.
Inside a normal array literal, `for` `(` iterator (`of` | `in`) iterable `)`
result-expression is also an element form. It implicitly spreads every result
into the surrounding array and may be mixed repeatedly with values and `...`.
An ordinary array element may also be `if` `(` condition `)` value with no
`else`; it conditionally contributes `value`, equivalent to spreading
`if (condition) [value] else []`. The comma after an unbraced `if` value is the
array separator, not a comma expression. Parenthesized `(a, b)` remains a comma
expression.
The result expression may be `if (...) value else value`. A top-level `if`
without `else` is a comprehension filter: false iterations append nothing, and
the true branch determines the element type. Comprehension elements use normal
array separators; a comma after an unbraced `if` branch separates elements,
and a final comma before `]` is valid.

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
  const kind: "ok" = result.kind
}
if (score is (>= 10 and < 20)) { use(score) }
if (path is /^\/users\/[0-9]+$/i) { const text: string = path }
```

`match` is an expression with ordered arms and optional subject. With `->`, omit
`when`; with `:`, `when` is mandatory. `else` and `default` are equivalent. A
braced arm yields its last expression without `do`, and the subject is evaluated
once with narrowed types available inside successful arms.

```vexa
const label = match {
  ready -> "ready"
  when retrying: "retrying"
  else -> "idle"
}

const result = match (value) {
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
const badge = Graphics()
  ..point = Vec2(centerX, centerY - 16)
  ..beginFill(0xff6b35)
  ..endFill()
```

## JSX / type casts

JSX is always enabled in `.vx` files. Use `value as Type` for casts — `<Type>value` is **not valid** in `.vx`.

- Empty JSX expression containers mean `undefined`: `prop={}` is equivalent to `prop={undefined}` and `{}` in a child list contributes an `undefined` child. Do not treat a following attribute as part of the empty container.

Inside JSX children, control blocks are expressions:

```vexa
{#for item of items}<Row value={item}/>{/for}
{#if ready}<Ready/>{:else if loading}<Spinner/>{:else}<Error/>{/if}
```

- `for` accepts `of` or `in`; its iterator is scoped to the block and the block yields an array.
- `if` supports any number of `{:else if condition}` markers and one optional `{:else}`; without a matching branch it yields `null`.
- Blocks may nest and may contain text, expression containers, elements, or fragments.
- Component tags are passed as references to the configured classic JSX factory. The factory/renderer, not JSX emission itself, decides when to call the component function.

## Comments

```vexa
// single-line
/// doc comment — shown in editor hover and completion tooltips
/* block */
```

## Conventions

- Semicolons are optional; idiomatic VexaScript omits them.
- Prefer `const` for immutable declarations and `func` for function declarations unless `vexascript.json.canonicalSyntax` selects another accepted alias.
- Annotations: `annotation Benchmark` / `@Benchmark func measure() {}`
- `@JsName("jsName")` overrides the emitted JavaScript identifier.
- `@JsInline("js template")` inlines raw JS at each call site.
- Native/FFI declarations use `@CppHeader`, `@CppFlags`, `@CppBody`,
  `@FFILibrary`, `@FFIName`, and `@FFIStruct`; consult `docs/syntax.md` for the
  ABI and security contract.
- Runtime namespaces: `namespace Foo { export func bar() {} }` creates a real JS object.
- `vexa test` discovers `.test.vx`; `test("name") { ... }` and strict
  `assert(condition)` are available without imports.
- Local `.ts`, `.tsx`, `.json`, and `.txt` files can be imported. Add `?text` to
  load any local file through one default string binding in JS and C++.
- Delegated variables: `var count by useState(0)` routes reads/writes through the delegate.
