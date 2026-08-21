# Definite assignment and class init blocks

## What changed

VexaScript now checks mutable `var` declarations for use before initialization,
requires `val` class fields to be initialized in situ, supports the explicit
`var!` escape hatch, and lowers instance `init { }` blocks through both runtime
backends. The diagnostic carries the declaration offset so the shared LSP and
Monaco code-action path can offer `var` → `var!` without re-parsing source text.

## Architectural lesson

Adding a new class-owned AST collection must be propagated through every AST
clone/lowering boundary, not only parser, traversal, and emitters. The first C++
test produced an empty constructor because `runtime/lowering.ts` rebuilt the
`ClassStatement` while dropping `initBlocks`; preserving and lowering the new
collection in both class-clone paths fixed the divergence. Future class AST
extensions should audit constructor calls and copy helpers immediately.

Definite assignment is kept in one dedicated semantic pass. It consumes Binder
scopes, tracks symbols rather than names, intersects assignment state at branch
joins, and models class field initializers, init blocks, and constructors as one
construction phase. This avoids duplicating name resolution or embedding a
second ad-hoc initialization rule in each emitter.

The first real Monaco validation showed another boundary loss: Monaco markers
preserve a diagnostic's code and range, but not its LSP `data` payload. The
quick fix therefore worked in direct LSP tests and reported “No code actions
available” in the playground. The shared fix producer now uses diagnostic data
when present and otherwise resolves the read's semantic symbol back to its AST
declaration. Editor-facing fixes that require declaration metadata should be
tested with marker-converted diagnostics as well as original LSP diagnostics.

## Follow-up: end-of-construction validation

The original checker registered class fields and reported reads that occurred
before assignment, but it never inspected the final construction state. A
class could therefore declare `var value: int`, never assign or read it, and
compile without a diagnostic. The fix keeps the same symbol-based flow state
and reports each checked field that remains absent after field initializers,
`init` blocks, and the constructor have all been visited. This also preserves
branch intersection: assigning a field in only one constructor branch is not
enough.

The first focused test run confirmed the gap simultaneously in four surfaces:
semantic analysis, the `var!` quick fix, semantic highlighting, and portable
syntax highlighting. No separate initialization model was needed; extending
the existing construction phase was sufficient. The new declaration
diagnostic has its own stable code while sharing the existing `var` to `var!`
fix producer.

`var!` is parsed as `var` plus an adjacent punctuation token, which is useful
for the parser but caused editor surfaces to color only `var` as a keyword.
Changing the tokenizer would have expanded the parser blast radius. Instead,
the portable Monaco/TextMate/CodeMirror rules recognize the compound spelling,
and the semantic-token builder merges the adjacent lexical tokens into one
keyword range. This keeps parsing unchanged while making every editor surface
agree on the visible token.

## Follow-up: class-field initializer assignability

Class fields already resolved their explicit annotation and visited their
initializer, but unlike local variables and extension properties they never
compared the two types. This was a parallel-path drift bug: `var value: int =
0.5` was rejected locally but accepted as a class field. The class-field path
now uses the annotation as contextual input and calls the same assignability
and mismatch-reporting helpers used by ordinary declarations. A focused test
asserts that `number` is rejected for `int` while an integer initializer remains
valid.

The existing type quick fix already knew how to change a field declaration
after an incompatible later member assignment, including inherited and
cross-file declarations. Initially adding a separate initializer-only action
would have duplicated its edit, deduplication, title, and refresh behavior.
Instead, the producer now resolves either a field initializer or a member
assignment into the same declaration-edit path. This keeps `int = 0.5` →
`number` and `int = "test"` → `string` consistent with the older assignment
fixes.

FFI samples exposed the intended boundary for the unchecked form: fields whose
storage is populated by native code must say `var!`, while mutable primary
constructor fields and fields with in-situ defaults remain ordinary `var`.
Keeping that distinction in executable and website examples prevents samples
from teaching `var!` as a general mutable-field spelling.

## Execution metadata

- Model: GPT-5
- Provider: OpenAI

## Prompts

~~~~text
Esto no da error y debería dar error por falta de inicialización de a:



```typescript
class Test {
  var a: int
}
```

\
si no se inicializa debería ser:



```javascript
class Test {
  var! a: int
}
```

también arregla el syntax highlighting para que `var!` entero se considere un solo keyword
~~~~

~~~~text
cuando termines, esto debería ser un error (porque 0.5 no debería ser asignable a un tipo entero):

```typescript
class Demo {
  var demo: int = 0.5
}
```
~~~~

~~~~text
y añade quickfix para cambiar el tipo int a number (o al tipo compatible). Por ejemplo `var a: int = "test"` debería añadir quickfix para cambiar el tipo a string: `var a: string = "test"`
~~~~

~~~~text
asegúrate también de que los samples tipo los de ffi y website, actualizan los var a var!
~~~~
