# Contextual call and literal inference

## Symptoms

Migrating a TypeScript platform game exposed a related group of false
diagnostics in otherwise conventional TypeScript patterns:

- parameters such as `volume = 0.32` were still required to declare an
  explicit type;
- optional Box2D parameters rejected structurally compatible values whose type
  included `undefined`;
- an event method constrained by `keyof` widened a valid event-name literal to
  `string`;
- `Promise.all([texturePromise, fetchPromise])` lost its positions and produced
  a union array instead of `[Texture, Response]`;
- `let facing: -1 | 1 = 1` rejected the exact numeric literal; and
- `getComponent(Rigidbody)` inferred the generic constraint `Component` rather
  than the constructor's instance type `Rigidbody`; and
- a transitive PIXI helper alias named `Input` shadowed the project's imported
  `Input` class, so `scene.input.down(...)` was checked against an unrelated
  `string | object` union; and
- type-checked CLI bundles of the game appeared to hang while recursively
  recollecting the same cyclic local modules through many different paths; and
- PIXI's asymmetric `Container.position` accessor was read as its setter input
  type `PointData`, hiding the `set` and `copyFrom` methods declared by the
  getter's `ObservablePoint` return type; and
- string-literal ternaries used as call arguments widened to `string`, so a
  valid `material === "ice" ? "snow" : "grass"` value was rejected by a
  `"grass" | "snow"` parameter; and
- loop conditions and `if (...) continue` guards did not carry their smart
  casts into the reachable body path;
- writes were checked against flow-narrowed reads, freezing mutable booleans
  and literal-union fields to one temporary member; and
- `typeof DIRECTIONS[number][2]`, arrow field `this`, and nested generic alias
  defaults such as PIXI's `Application.canvas: R["canvas"]` lost type
  information; and
- completion did not offer a parameter's string-literal union members inside
  equality comparisons.

## Causes and fixes

Default values already typed the parameter binding inside the function, but
the callable signature and lightweight declaration symbol retained `unknown`.
Callable construction now reuses the default's inferred type, while the
missing-annotation diagnostic remains for parameters without either a type or
a default.

Optionality was stored separately from the parameter type. Argument checking
compared an explicitly supplied `T | undefined` value against bare `T`; the
shared expected-parameter helper now includes `undefined` for optional
parameters in overload matching, contextual typing, and final validation.

Constrained generic inference did preserve the first string literal initially,
but contextualizing a later object argument rebuilt the argument list from the
original widened types. Contextual refinement now starts from the already
literal-sensitive inference list, so refining one argument does not erase
information from another.

The Promise special case deliberately downgraded inline tuple candidates to
arrays. Removing that exception preserves positional `Promise.all` and
`Promise.allSettled` results while declared arrays and other iterables retain
array results.

Unsuffixed numeric expressions still infer `number` generally. Exact numeric
literals, including unary-negative forms, now use the expected literal union
only for contextual validation. This keeps `number`-by-default semantics while
accepting valid `-1 | 1` initializers, direct assignments, and conditional
expressions whose branches are both members of the union.

Finally, a class identifier was represented by its instance type in ordinary
expression analysis. Generic call inference now substitutes the class's
constructor signature when that identifier is used as an argument, allowing a
constructor return type `T` to infer the concrete instance.

Imported declaration collection also flattened project and dependency helpers
into unqualified lookup tables. Declaration locations now flow into semantic
analysis, and alias lookup uses that provenance: a `node_modules` helper cannot
shadow a same-named project class in project code, while dependency declarations
continue to resolve their own helper alias. An explicit project import of the
alias still selects it.

The import collector's path-local cycle guard prevented direct infinite
recursion, but it did not reuse completed subgraphs. A per-traversal promise
cache now memoizes each local file, turning diamond and cyclic import collection
from exponential repetition into one collection per module. The CLI module
graph also forwards declaration locations into semantic analysis, so it follows
the same provenance rules as the LSP.

Class member collection previously stored getters and setters in one map, so a
later setter overwrote its getter. Member reads now retain the getter return
type, while pure assignment targets resolve the setter parameter independently.
This preserves TypeScript's asymmetric accessor semantics without weakening
write validation.

Call contextualization previously revisited functions, objects, arrays, and
nested calls, but skipped conditional expressions. Conditional arguments now
receive the parameter's expected type, allowing each string or numeric literal
branch to retain the matching literal-union member.

Conditional branch scope construction is now shared by `if`, `while`, and
classic `for`. Continuation analysis treats `continue` and `break` like other
abrupt branches for the statements that follow within the current body, so a
negated compound guard retains all facts from its false path.

Assignment analysis now separates the declared write type from the current
flow-narrowed read type. The same declaration information feeds editor
completion for string-literal union assignments.

Type queries now peel and resolve each trailing indexed-access segment instead
of consuming the complete annotation as one value name. Const assertions keep
nested literal arrays as readonly tuples. Generic alias expansion applies
independent omitted defaults before member substitution, while class-member
analysis retains direct indexed access through an owner type parameter. This
preserves chained tuple indexing and PIXI's nested
`Renderer<T = HTMLCanvasElement>` default without disturbing mapped aliases.
The binder also declares the class instance receiver in field-initializer
scope, allowing arrows stored in fields to capture `this` lexically.

Literal-union completion now reuses the analyzed type of the left operand at
equality comparisons, including flow-narrowed parameters, and inserts only the
literal contents when the cursor is already inside quotes. In that quoted
context the literal list is exclusive, so unrelated visible symbols are not
mixed into the suggestions.

## Investigation notes

The optional Box2D error initially looked like incomplete structural interface
compatibility, but the same object shapes assigned correctly without the
optional wrapper. The missing `undefined` in call validation was the actual
boundary.

Likewise, the constrained event literal was narrowed during the first inference
pass. The widening happened later when another argument received contextual
object typing, which made the defect appear to be in constraint inference
itself.

The full platform-game graph was compiled with the modified local compiler to
verify the fixes together. This exercised imported classes, Box2D declarations,
the atlas loader's heterogeneous Promise tuple, event payload indexing, the
real default-valued methods, and the large cyclic import graph without changing
the game sources. It also covered PIXI's real `get position(): ObservablePoint`
and `set position(value: PointData)` declaration pair, its generic
`Application.canvas` getter, Box2D linked-list loops, and polygon guard
smart-casts. Remaining diagnostics were unrelated existing typing gaps; the
bundle now terminates and no longer reports `Input.down` as missing, treats
readable positions as `PointData`, widens the platform material ternaries to
`string`, or reports the canvas itself as `unknown`.

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: Unavailable (not exposed by runtime)
