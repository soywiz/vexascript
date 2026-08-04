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
