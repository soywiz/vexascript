# Primary base-constructor forwarding must use parameter scope

## Context

VexaScript primary constructors could declare a base type, but the parser did
not retain a following argument list such as `class Child(value: int) :
Base(value)`. The trailing tokens therefore could not be type-checked or emitted.
The analyzer also allowed direct calls and `new` expressions for abstract
classes.

## Failed intermediate approach

The first implementation visited each base argument in the normal class scope.
That scope intentionally models primary-constructor declarations as implicit
instance members for method bodies. Consequently, the backend rewrote `value`
in `Base(value)` to `this.value`. JavaScript then attempted
`super(this.value)`, which is illegal before `super`, and C++ emitted
`Base(this->value)` before the derived field was initialized.

A second intermediate version emitted `super()` whenever `extendsType` existed.
In the VexaScript colon grammar, that slot can hold an interface that the
JavaScript emitter intentionally erases from the runtime `extends` clause. This
produced a syntax error in interface-delegating classes. Runtime base detection
must therefore be shared with `extends` emission, rather than inferred from the
raw AST slot alone.

## Resolution

Base arguments are now stored once on the class AST and traversed by the shared
AST traversal. Semantic analysis evaluates them in a dedicated scope where the
primary-constructor declarations are ordinary parameter symbols. This keeps
type checking and go-to-definition tied to the parameter declaration while
preventing implicit-`this` rewriting. The same AST arguments feed the formatter,
JavaScript synthetic constructor, and native C++ base initializer.

Abstract construction is rejected in the common class-construction analysis
used by both call syntax and `new`, while normal symbol resolution is preserved.

## Regression guidance

- Test both runtime backends whenever constructor ordering changes.
- Assert that `super(...)` precedes every derived property assignment.
- Include a wrong-type base argument so parser-only support cannot masquerade as
  semantic support.
- Cover both `AbstractClass(...)` and `new AbstractClass(...)` diagnostics.
