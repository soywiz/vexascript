# Persisted AST caches must restore node prototypes

## Symptom

Full test runs intermittently lost all DOM declarations in one browser-facing
suite. Pixi, Three.js, or DOM inlay-hint tests failed with undefined `document`
and `window`, while the same test file passed immediately when run alone. One
failure also reported that a binding field was not iterable.

## Investigation

The failures moved between test files, so neither the samples nor their project
configuration explained them. Repeated isolated runs loaded the same DOM source
successfully. The decisive clue was that the runtime program cache serialized
class-based AST nodes as JSON and returned the parsed objects directly. JSON
preserved numeric `kind` fields but discarded prototypes, so every semantic path
that uses `instanceof` silently stopped recognizing cached declarations.

The Node cache filename included the process ID, which made the defect appear
intermittent: a fresh PID generated real nodes, while a reused PID could consume
a cache file left by an older process. Changing the filename or cache version
would only postpone the same failure. Disabling the cache would avoid the bug but
would discard the intended browser startup optimization.

## Resolution

Cached programs are now revived recursively. Every object with a valid
`NodeKind` receives the prototype of the matching exported AST class before the
program is returned. Unknown kinds invalidate the entry and fall back to a fresh
parse. The cache test now checks `Program`, `ExprStatement`, and `Identifier`
identity with `instanceof`, covering the contract semantic analysis actually
depends on rather than only deep JSON equality.

## Lesson

A serialized AST is not equivalent to the in-memory AST when consumers rely on
class identity. Cache tests must validate behavioral representation invariants,
not just structural equality. Random failures concentrated in declaration-heavy
features can be stale representation bugs even when the declaration source and
hash are correct.
