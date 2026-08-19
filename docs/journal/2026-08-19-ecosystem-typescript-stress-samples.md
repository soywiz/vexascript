# Ecosystem TypeScript stress-sample regressions

## Context

Eleven runnable samples were added against unmodified published packages:
Zustand, Hono, RxJS, XState, TanStack Table, Effect, Drizzle, Kysely, tRPC,
Viem, and React Hook Form. Each sample has deterministic runtime output and
keeps the package declarations as the source of truth. The work deliberately
avoided local declaration shims, broad sample-owned casts, and replacing a hard
API with an easier package-specific path.

The packages exposed failures in three shared layers: selective declaration
loading, generic semantic analysis, and runtime package bundling. Fixing only
the first diagnostic visible in a sample repeatedly uncovered an earlier loss
of information in one of those layers.

## Declaration graph and parser findings

- Selective `node_modules` loading must retain the declarations that support a
  requested export across import files, named re-exports, export-star barrels,
  package export maps, and declaration-format variants. A correct exported
  function is not useful if an internal return type or its transitive helpers
  disappear before analysis.
- Type-only declaration dependencies must be collected transitively from type
  parameters, constraints, return types, members, and nested type text. The
  dependency walk and the declaration selection need one canonical index;
  resolving the same graph again in each editor feature would reproduce the
  drift this work removed.
- A type literal may begin with a non-generic anonymous call signature such as
  `(): T`, not only a property, index signature, or generic `<T>(...)` call
  signature. The parser previously recovered past the entire alias. React Hook
  Form then reported `UseFormWatch` and `UseFormGetValues` as unknown even though
  the source file declared them. The minimal parser regression now preserves a
  callable object alias independently of that package.
- Function-type detection must inspect a top-level arrow. Treating any nested
  `=>` as proof that the whole annotation was a function type caused recursive
  tRPC router annotations to collapse before alias resolution.
- Dotted basenames, conditional package exports, and ESM declaration/runtime
  entry points need to resolve through the shared module resolver. Package
  bundling now follows the same effective export instead of guessing a nearby
  JavaScript file after semantic analysis chose the declaration file.

## Generic analysis findings

- Generic inference can revisit the same recursive parameter/argument type pair
  through mutually recursive objects. A `WeakMap`/`WeakSet` pair guard terminates
  only the repeated edge while allowing independent inference paths to proceed.
- External types nested inside runtime utility aliases such as `Omit` need to
  remain visible for the duration of that alias expansion. The visibility state
  is reference-counted and scoped to the active type arguments; globally making
  every external declaration visible would reintroduce local/ambient name
  collisions.
- Conditional parameters may expose an identity type parameter in either branch.
  Inference must reconstruct the complete conditional annotation, infer from the
  identity branch, and avoid replacing a concrete inference with an argument
  that still contains the same unresolved parameter.
- Homomorphic mapped types over tuples must preserve tuple position and literal
  length. Flattening them to ordinary arrays loses the ABI tuple information
  Viem uses for validator parameters and encoded function data.
- Textual type-parameter substitution is unsafe for structural object and
  intersection aliases because an identifier may be a property key rather than
  a type reference. Structural targets are parsed first and substituted through
  the type model instead.
- Intersections whose unresolved validation tail evaluates to `never` can still
  expose a valid structural head for contextual typing. Using that head as a
  conservative open shape preserved Viem's declaration-driven object inference
  without adding ABI names or package-specific catalogs.
- A parameter whose declared type includes `void` is omittable in the same way
  TypeScript permits callbacks and procedures with an optional void-valued
  input. This mattered in tRPC procedure calls and is covered as general call
  analysis behavior.
- Indexed access must be recognized before a generic name is flattened. Kysely
  and React Hook Form both depend on a literal key inferred by one argument being
  substituted into the type of a later argument.
- Overload ranking must compare fully instantiated signatures, including their
  return types and dependent defaults. Ranking a generic shell can select an
  overload whose parameter list looks plausible but whose result loses the
  caller's object map.
- Merged declarations need to retain the type parameters owned by each original
  member. Applying the merged interface's final parameter list to every member
  corrupts members contributed by a declaration with a different generic owner.
- Polymorphic `this` in generic classes and interfaces must carry the current
  type arguments. Replacing it with only the declaration name lost builder
  configuration through inherited classes and fluent `this & { ... }` returns.
- Contextual inference through a structural alias head is useful, but it cannot
  stop after the first matching property. The remaining conditional or mapped
  parts may contain the only occurrence of the type parameter being inferred.
- Recursive contextual callback discovery must track type object identity, not
  printed type strings. Distinct aliases can print identically while exposing
  different callable paths.

## Declaration provenance findings

- `export =` packages require the callable export to take priority over a
  namespace-shaped collection of direct exports. The namespace remains useful
  for members, but it is not a replacement for the default callable value.
- A declaration first loaded as support can later become a public namespace or
  named re-export. The selective collector must preserve and re-tag the already
  collected declaration instead of treating the earlier visit as proof that no
  export work remains.
- Filtering same-name support declarations must retain the concrete declaration
  behind a public re-export. Keeping only the barrel's export specifier leaves a
  valid public name with no callable or member-bearing declaration to resolve.
- Recursive schema aliases can often be broken safely at a declared interface
  property such as `_zod`, `shape`, `element`, or tuple `items`. These structural
  facts should be attempted before falling back to a recursive output alias.

## Investigation branches that did not solve the problem

- Simplifying the samples or pinning older packages would have hidden the exact
  declaration constructs the samples were intended to validate.
- The first React Hook Form failure looked entirely like lost external-type
  provenance. Scoping external type-argument visibility fixed `UseFormReturn`,
  but the next diagnostic showed that two dependent aliases were absent from the
  parsed declaration graph. Instrumenting declaration presence, rather than
  adding more visibility exceptions, identified the missing `(): T` parser case.
- Viem's first failures looked like ordinary direct generic inference. Adding
  only direct substitutions moved the failure into conditional validators;
  flattening mapped tuples then moved it into indexed tuple length; and textual
  structural substitution corrupted object keys. The durable fix kept each
  representation structured through inference and expansion.
- Re-running inference without a recursion guard produced a stack overflow on
  React Hook Form. Returning `unknown` at a fixed depth would have terminated but
  made results depend on traversal depth. Guarding the exact active type pair is
  deterministic and preserves all non-cyclic work.
- Returning immediately after inferring from the structural head of a config
  alias fixed one Viem-shaped object but regressed XState-style conditional
  wrappers. Continuing through the rest of the alias recovered the missing
  inference without removing the conservative structural head.
- Treating every string argument to a generic as a literal fixed Kysely keys but
  over-specialized ordinary identity functions. Literal preservation is now
  limited to const parameters or constraints whose result depends on the
  literal; broad unconstrained generics retain widened values.

## Regression strategy

Keep both layers of coverage:

1. focused parser, module-resolution, declaration-graph, generic-inference, and
   bundler tests for each smallest failing construct; and
2. runnable samples using the real package versions and deterministic
   `expected.txt` output.

When another package fails, inspect the earliest point where its declaration
shape or provenance disappears. Do not add package names, framework value
catalogs, or sample-side typings to the compiler. For performance regressions,
use the queryable counter workflow in
`.codex/skills/optimize-vexascript-compiler-lsp/` so cache and traversal work is
bounded deterministically rather than through wall-clock test thresholds.
