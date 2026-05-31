# MyLang Semantic Specification (Current Behavior)

This document describes the current semantic behavior implemented by MyLang analysis.

Scope:

- It reflects the behavior of `compiler/analysis/*` as of this revision.
- It is intentionally implementation-oriented and may evolve with future type-system work.

## Type Model

MyLang currently uses these core type categories:

- Builtin scalar types: `int`, `number`, `string`, `boolean`, `bigint`, `long`.
- Builtin value-like names exposed by binder: `true`, `false`, `null`, `undefined`, `console`.
- Named types: class names resolved as nominal named types.
- Function types: parameter list + return type.
- Structural helper types used by analysis internals: array/range/object/unknown.

Notes:

- `unknown` is used as fallback whenever type information is missing or cannot be resolved.
- Class declarations introduce a named type equal to the class identifier.

## Symbol Binding and Visibility

Binding is lexical and scope-based:

- The binder creates nested scopes for blocks, functions, loops, conditionals, switch/try branches, classes, and methods.
- Visible symbols at a position are gathered from innermost scope to outermost scope.
- Declarations in the same lexical scope update existing symbols when type information becomes more precise.

Current top-level declaration kinds:

- Variables (`let`, `var`, `val`, `const`).
- Functions.
- Classes.
- Imports (imported names are treated as symbols with initially unknown type).

## Type Inference Rules

### Variable declarations

For each variable declaration:

1. If an explicit annotation exists, it is resolved first.
2. If an initializer exists, its expression type is computed.
3. Final variable type is:
   - explicit annotation, else
   - initializer type, else
   - `unknown`.

If both explicit and initializer types are known and incompatible, a type mismatch diagnostic is emitted.

### Function declarations

- Function symbol type is built from parameter types + return type.
- Parameter type is:
  - explicit annotation, else
  - default-value expression type (if present), else
  - `unknown`.
- Function return type is:
  - explicit annotation, else
  - `unknown`.

### Class declarations and members

- Class symbol type is the named class type.
- Method symbols are function-typed using method parameter and return annotations (with the same parameter inference rule as functions).
- Field initializer expressions are analyzed for diagnostics, but field type is primarily annotation-driven in current behavior.
- Primary constructor parameters are treated as class properties for member resolution in LSP/class utilities.

## Assignability Rules

Two types are assignable when:

- They are exactly the same type, or
- Source is `int` and target is `number`, or
- Source is `long` and target is `bigint`.

No other widening/narrowing or structural compatibility is currently implemented.

Consequences:

- `string` is not assignable to `number` or `int`.
- Named types are nominally compared by exact name in current behavior.
- `unknown` suppresses mismatch checks when either side is unknown.

## Expression and Statement Checks

Current semantic diagnostics include:

- Undefined variable access.
- Unknown type annotation names.
- Type mismatch in variable initialization against annotation.
- Type mismatch in assignment expressions (`left` vs `right`).
- Function call arity issues:
  - too few arguments,
  - too many arguments,
  - unexpected extra arguments.
- Function call argument type mismatches.
- Invalid control-flow statements:
  - `continue` outside loops,
  - `break` outside loops/switch.
- Missing class members in member-access checks.

## Cross-File Semantic Checks (LSP)

LSP augments single-file analysis with project-aware checks:

- Missing members on imported/externally resolved class types.
- Cross-file member call arity and argument-type checks.
- Cross-file assignment mismatch checks on resolved class members.

These checks are implemented in dedicated LSP diagnostics passes and merged with base analysis diagnostics.

## Known Limitations

This semantic layer is intentionally conservative today:

- Function type compatibility is stricter than TypeScript-style structural compatibility.
- Generic type parameters and instantiation are not supported.
- Object shape/interface member typing is incomplete.
- Array propagation and nested-expression mismatch explanations are still limited.

Pending roadmap items are tracked in `docs/tasks.pending.md` and `docs/syntax.pending.md`.
