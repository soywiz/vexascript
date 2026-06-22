# 2026-06-22: Property Reference Expressions

## Context

`expr::field` was added as a property-reference expression. The expression type is `Property<T>`, where `T` is the resolved member type. Runtime emission lowers the expression to an object with `name: string` and get/set `value: T`, evaluating the receiver once so it is compatible with existing `by` delegated variables.

## What Worked

- Reusing the existing member-resolution path was the right shape. `PropertyReferenceExpression` creates a synthetic non-computed `MemberExpression` for type checking, visibility diagnostics, hover, and go-to-definition.
- Treating `Property<T>` as a named type kept extension index operators simple: `fun Property<number>.operator[](src, dst)` resolves through the existing extension operator path.
- The first implementation used a hidden getter/setter tuple for runtime lowering, but that made `Property<T>` impossible to use through its public declaration. The final shape emits a value object, so `property.value`, `property.value = next`, and `var x by property` all share the same runtime path.
- A strengthened test using `TweenTarget(this, src, dst)` exposed that extension receiver type arguments were parsed but not preserved for the receiver `this` symbol. Binder now builds the full receiver type from `receiverType + receiverTypeArguments`.
- The full test suite exposed a second generic-extension gap: `val <T> Array<T>.firstItem: T` accepted `T` only after the receiver scope was fixed, but member access still returned raw `T` for `int[]`. Extension property metadata now keeps receiver type arguments and substitutes them from the actual receiver type when resolving the member.
- Adding the first non-annotation Vexa runtime declaration (`Property<T>`) exposed that Binder and TypeChecker were not collecting Vexa runtime classes/interfaces/type aliases the same way they collect ECMAScript runtime declarations. The runtime collection path now handles those declarations too.

## Dead Ends Avoided

- A separate property-reference delegate path would have duplicated `by` runtime behavior and likely diverged from normal value-object delegates.
- Emitting `expr::field` as `[() => expr.field, value => expr.field = value]` would have been shorter but incorrect for receivers with side effects. The receiver must be captured once.
- Leaving `Property<T>` as a purely synthetic checker type made simple tests pass, but failed once extension operator bodies used `this` as `Property<number>`. Runtime declarations need to be real declarations when users can mention them.

## Follow-Up Risk

Property references currently support identifier fields. If bracket-based property references are added later, they should reuse the same synthetic-member strategy where possible and preserve single evaluation of both receiver and key.
