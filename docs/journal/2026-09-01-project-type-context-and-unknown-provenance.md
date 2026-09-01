# Project type context and unknown provenance

## Symptoms

A real Pixi/Box2D game exposed two failures that amplified each other. Imported
members such as `Application.canvas`, a project `Input` class, and generic
component factories sometimes became `unknown` or resolved to an unrelated
same-named dependency alias. Separately, `vexa bundle` repeatedly traversed the
same cyclic local graph through the node-module declaration collector, taking
about a minute before emitting a cascade of downstream diagnostics.

Those downstream errors obscured the useful boundary: an explicitly annotated
member had already failed to resolve. Treating that result like `any` would have
made the project run, but it would also have removed the safety promised by
`unknown`.

## Causes and fixes

The runtime module graph collected direct local exports but did not preserve a
complete local type context for transitive imports or cyclic consumers. It also
mixed dependency support declarations and project declarations without a stable
priority. Each module then sent its full AST to the node-module resolver, which
re-entered local imports that the module graph had already visited.

The module graph now propagates per-module declaration contexts, registers
deferred consumers for cycles, and orders project-local declarations after
dependency support declarations so local names remain authoritative. The
node-module bridge receives project ambient declarations and only traverses bare
package imports. This keeps DOM-dependent package generics resolvable while
leaving local traversal in one place.

Semantic analysis now distinguishes explicit `unknown` from an annotated member
whose type unexpectedly resolves to `unknown`. Explicit `unknown` remains legal
and restrictive. An accidental result reports one diagnostic on the annotated
member itself, and the immediate member-access cascade is suppressed; it is not
converted to `any`.

The real game now builds without diagnostics in about 1.2 seconds and bundles
in about 7.3 seconds, down from roughly 61 seconds for the failing bundle.

## Investigation notes

The first optimization attempt focused on the module graph's ordinary visited
set. That set already prevented duplicate runtime emission, so it did not
explain the delay. Timing and import-path tracing showed that package declaration
collection independently followed local imports for every module. Filtering the
bridge to bare imports removed the repeated work.

Adding DOM declarations only at the game entrypoint fixed direct globals but not
`Application.canvas`: the package's generic default had to be resolved while
analyzing its declaration graph. Passing the same ambient declaration set into
the package resolver fixed the origin rather than adding a canvas-specific
special case.

Finally, diagnosing every inferred `unknown` was too broad. Unannotated arrow
fields may be queried before their initializer has been analyzed, so the origin
diagnostic is intentionally limited to explicitly annotated members whose
annotation is not itself `unknown` (or a union containing it).

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: OpenAI
