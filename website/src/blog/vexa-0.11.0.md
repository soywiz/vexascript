---
layout: blog-post.njk
title: "What's new in VexaScript 0.11.0"
date: 2026-08-02
category: Release announcement
version: 0.11.0
summary: VexaScript 0.11.0 adds control-flow expressions, pattern matching, better type inference, and updates to the native CLI and release tools.
tags: blog
permalink: /blog/vexa-0.11.0.html
---

VexaScript 0.11.0 was tagged on 2026-08-02 at commit `b9f2358f`. It
includes 66 commits made after version 0.10.0.

The main additions are control-flow expressions and pattern matching. The
release also improves type inference for standard TypeScript APIs, adds more
features to the native CLI, and makes the release process safer.

## **Release overview**

The work in this release falls into four main areas:

| Area | Main changes | Commits |
| --- | --- | --- |
| Language | Control-flow expressions, `match`, character literals, template shorthand, and optional receiver blocks | `0eeb9d50` to `8bc654e5` |
| Type system | Better Promise, collection, tuple, and union inference | `a967d676` to `cde3141d` |
| Native tools | More optimization options, project bundling, and cross-platform CI fixes | `967288b5` to `27db4f1e` |
| Releases | Synchronized package versions and annotated Git tags | `82e33d84`, `b9f2358f` |

The release changed 236 files. Git reports 15,593 added lines and 14,493
removed lines. These numbers show the size of the change, but the rest of this
article focuses on what users can do with it.

## **Control flow can now be used as a value**

VexaScript now allows `if`, `return`, `throw`, `break`, and `continue` where an
expression is expected.

This makes common checks shorter. For example, a function can stop immediately
when an array item is missing:

```vexa
fun lookup<T>(items: T?[], index: int): T {
  val item = items[index] || throw Error("Not found")
  return item
}
```

An `if` expression can also return a value. When a branch uses braces, its last
expression becomes the result:

```vexa
val label = if (ready) "ready" else {
  prepare()
  "prepared"
}
```

An expression such as `throw` or `return` has the type `never`. This means it
does not add another possible type to the result. In the `lookup` example,
`item` keeps the type `T` because the missing-value branch always throws.

JavaScript and C++ have different rules for statements and expressions. The
compiler handles this before it generates code for either backend. It converts
the new expression forms into ordinary variables, assignments, `if`
statements, and control statements. This conversion is called lowering.

The lowering step keeps the original evaluation order. It also keeps normal
short-circuit behavior for `&&`, `||`, and `??`. A `break` or `continue` still
targets the correct loop.

Two other implementations were considered. Wrapping the code in a hidden
function would make `return` exit the hidden function instead of the user's
function. It would also prevent `break` and `continue` from reaching the outer
loop. Hidden exceptions would create a different problem because user `catch`
blocks could intercept them. Lowering the syntax before code generation avoids
both issues.

## **Pattern matching with `match`**

The new `match` expression checks its arms from top to bottom. The first arm
that matches provides the result.

```vexa
fun describe(value: any): string => match (value) {
  { kind: "ok", payload: val payload: string } -> `ok: $payload`
  [string, val count: number, ...] -> `count: $count`
  /^user-[0-9]+$/i -> "user id"
  >= 10 and < 20 -> "teen"
  else -> "unknown"
}
```

Patterns can check:

- primitive types such as `string`, `number`, and `boolean`;
- class types;
- literal values;
- object properties;
- arrays, including one `...` wildcard;
- numeric ranges written with relational operators;
- regular expressions;
- combinations made with `and` and `or`.

A pattern can also create a variable for one arm. In the example above,
`payload` and `count` exist only inside the arm that declares them. The compiler
infers their types from the pattern, or checks an explicit type when one is
provided.

The compiler does not use a separate runtime matcher. The parser converts each
`match` to the same internal form used by `if` expressions. This lets the type
checker and both code generators reuse the existing conditional logic.

Testing found several problems that were not visible in the first
implementation:

| Problem | Fix |
| --- | --- |
| The formatter printed the generated `if` code instead of the original `match` | Store enough source information to print the original syntax |
| Assigning to a simple subject changed a temporary copy | Use the original variable when the subject is already an identifier |
| `{ payload }` was parsed as a lambda | Treat braces as an object pattern inside `match` |
| `< 20` was parsed as JSX | Parse relational patterns before trying JSX |
| Tuple indexing returned every possible element type | Keep literal indexes such as `0` and `1` during type analysis |

The formatter keeps only the source information it needs. Type checking and
code generation still use the converted `if` representation.

## **Character literals, templates, and receiver blocks**

Single quotes now create integer character values in `.vx` files:

```vexa
val ascii: int = 'a'        // 97
val emoji: int = '😀'       // 128512
val text: string = "hello"
```

A character literal must contain exactly one Unicode code point. The editor
offers a quick fix when a value such as `'hello'` should use double quotes.

This change required the tokenizer to keep the original quote character. It
previously stored only the decoded text, so later compiler stages could not
tell single and double quotes apart. TypeScript files still treat both quote
styles as strings.

Template strings now accept `$name` as a short form of `${name}`:

```vexa
val name = "Ada"
val greeting = `Hello $name`
```

Both forms are converted to the same internal expression. The package bundler
also uses the tokenizer, so it now selects TypeScript mode when it reads
JavaScript and TypeScript dependencies. Without that setting, `$name` inside a
third-party template string could be treated as VexaScript syntax.

Optional receiver blocks are also supported:

```vexa
canvas.getContext("2d")?. {
  fillStyle = "#f4f8fc"
}
```

The receiver is evaluated once. The block runs only when the value is not
`null` or `undefined`. Inside the block, the receiver has its non-null type.

## **Better type inference for standard APIs**

Version 0.11.0 improves type inference for Promises and collections. The work
uses the declarations from the TypeScript standard library instead of adding
special rules for every API.

The main improvements include:

- `Promise.all` keeps the type of each item in a typed tuple;
- `Promise.allSettled` keeps separate result types for each tuple position;
- empty Promise collections receive useful result types;
- strings and boxed strings work as iterable collections;
- typed arrays provide their element type to generic APIs;
- `Map` and `Set` constructors infer types from their entries;
- callback parameters receive better contextual types;
- `sync` auto-await, return hints, and return-type fixes use the same Promise
  unwrapping logic.

Union narrowing also improved. Checks in `if` statements and `switch` cases now
help the compiler select the correct member of a union. Invalid property access
is still reported when a property does not exist on every possible member.

Some broad fixes caused regressions and were removed. Merging every generic
type candidate made Promise constructor errors less accurate. Inferring a union
for every array literal broke existing tuple inference. The final changes apply
only when a collection, callback, or control-flow check provides the required
type information.

## **Native CLI, CI, and release tools**

The native `cpp link` and `cpp run` commands now accept `-O0`, `-O1`, `-O2`,
`-O3`, `-Os`, `-Oz`, and `-Og`. The selected option is part of the build cache
key, so the CLI does not reuse a binary built with a different optimization
level.

The native CLI can also run the project bundler itself. The first version
started the JavaScript CLI as a child process. That made a small test pass, but
the native executable still depended on Node.js. The final version compiles the
shared bundler to C++.

VexaScript and TypeScript files still use the full compiler. JavaScript package
files use a smaller tokenizer-based step that rewrites imports and exports but
leaves the rest of the file unchanged. A native CLI built with `-O0`
successfully bundled the Pixi sample, which then ran in a browser.

Runtime declarations now use `?text` imports. This lets the Node CLI, native
CLI, website, and VS Code extension read the same `es2025.d.ts`,
`vexascript.d.vx`, and `dom.d.ts` files. The repository no longer needs a
second generated copy of those declarations.

Native CI uses a different workload on each operating system:

- Linux runs the largest sample and self-hosting tests.
- macOS runs a representative native program, including an Oilpan stress run.
- Windows checks build arguments, packaging, and a smaller native executable.

This split avoids two known toolchain problems. The full macOS stress job took
longer than the CI limit, and MinGW GCC 15.2.0 crashed while compiling the large
self-hosted CLI file. Every platform still compiles and runs native code.

The release also adds `pnpm bump <version>`. The command:

- checks that the version is valid;
- requires a clean Git working tree and an active branch;
- rejects tags that already exist locally or on the remote;
- updates the main package and VS Code extension versions together;
- creates an annotated Git tag and pushes it.

This command does not publish to npm, upload the VS Code extension, or deploy
the website. Those are still separate steps.

There are also limits in the new language features. `match` does not support
custom matcher objects, computed object keys, object rest, or array rest
bindings. Regular-expression patterns support only the portable `g` and `i`
flags. The C++ backend still supports a subset of the full JavaScript runtime.

The facts in this article come from Git history, engineering notes, current
source code, and tests. The main implementation lesson is simple: convert new
syntax to a shared internal form before generating JavaScript or C++. This
keeps the behavior consistent across the compiler, editor tools, and both
backends.
