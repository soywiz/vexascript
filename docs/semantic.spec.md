# MyLang Semantic Specification (Current Behavior)

This document describes the current semantic behavior implemented by MyLang analysis.

Scope:

- It reflects the behavior of `compiler/analysis/*` as of this revision.
- It is intentionally implementation-oriented and may evolve with future type-system work.

## Type Model

MyLang currently uses these core type categories:

- Builtin scalar types: `int`, `number`, `string`, `boolean`, `bigint`, `long`.
- Builtin value-like names exposed by binder: `true`, `false`, `null`, `undefined`, `console`.
- Named types: class and interface names resolved as nominal named types.
- Type aliases resolve to their target type, including generic alias substitution.
- Union, intersection, literal, and tuple type annotations resolve to dedicated semantic types.
- Generic type parameter names are recognized in class/interface/type-alias type-annotation contexts.
- Function types: parameter list + return type.
- Structural helper types: array/range/object-shape/tuple/union/intersection/literal/unknown.

Notes:

- `unknown` is used as fallback whenever type information is missing or cannot be resolved.
- Class and interface declarations introduce a named type equal to the declaration identifier; type aliases introduce a type-only name that expands to its aliased target.

## Symbol Binding and Visibility

Binding is lexical and scope-based:

- The binder creates nested scopes for blocks, functions, loops, conditionals, switch/try branches, classes, and methods.
- Visible symbols at a position are gathered from innermost scope to outermost scope.
- Declarations in the same lexical scope update existing symbols when type information becomes more precise.

Current top-level declaration kinds:

- Variables (`let`, `var`, `val`, `const`).
- Functions.
- Classes.
- Interfaces.
- Type aliases.
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

### Type aliases

- Type aliases are type-only declarations and do not emit JavaScript.
- Alias annotations are expanded before compatibility checks, so `type Text = string` behaves like `string`.
- Generic aliases substitute provided type arguments into the target type before member lookup and assignability checks.

## Assignability Rules

Two types are assignable when:

- They are exactly the same type, or
- Source is `int` and target is `number`, or
- Source is `long` and target is `bigint`.
- Function-to-function compatibility holds when:
  - source provides at least target required parameters,
  - each source parameter type is assignable to corresponding target parameter type,
  - source return type is assignable to target return type.
- Array/range element types are assignable recursively.
- `range<T>` is assignable to `array<T>` when element assignability holds.
- Object-shape types are structurally assignable when required members are present and assignable.
- Object-shape values are assignable to named class types when matching class members are present.
- Literal values are assignable to their matching primitive builtin type, and contextual literal checking accepts matching literal annotations.
- A source is assignable to a union target when it is assignable to any member; a union source must have every member assignable to the target.
- A source is assignable to an intersection target when it is assignable to every member.
- Tuple values require compatible element counts and element types for tuple targets, and tuple values can be assigned to arrays when every element is compatible with the array element type.

Consequences:

- `string` is not assignable to `number` or `int`.
- Named types are still nominally compared by exact name, except object-shape to named-member structural checks.
- `unknown` suppresses mismatch checks when either side is unknown.

## Expression and Statement Checks

Current semantic diagnostics include:

- Undefined variable access.
- Unknown type annotation names.
- Type mismatch in variable initialization against annotation.
- Type mismatch in assignment expressions (`left` vs `right`).
- Reassignment/update attempts on `const`/`val` variables.
- Nested mismatch context diagnostics for complex expressions.
- Function call arity issues:
  - too few arguments,
  - too many arguments,
  - unexpected extra arguments.
- Function call argument type mismatches.
- Contextual generic function return inference from variable annotations and assignment targets, including nested calls inside array literals and object-literal properties.
- Invalid control-flow statements:
  - `continue` outside loops,
  - `break` outside loops/switch.
- Missing members in member-access checks for both named and inferred object-shape types.

## Cross-File Semantic Checks (LSP)

LSP augments single-file analysis with project-aware checks:

- Missing members on imported/externally resolved class types.
- Cross-file member call arity and argument-type checks.
- Cross-file assignment mismatch checks on resolved class members.

These checks are implemented in dedicated LSP diagnostics passes and merged with base analysis diagnostics.

## Known Limitations

This semantic layer is intentionally conservative today:

- Full generic constraints and call-argument contextual inference remain pending.

Pending roadmap items are tracked in `docs/tasks.pending.md` and `docs/syntax.pending.md`.
