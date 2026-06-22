# Index operator overloads

Implemented `operator[]` and `operator[]=` as overloadable operators without adding them to `BinaryExpression.operator`. The parser consumes `operator[]` and `operator[]=` as multi-token operator declarations/imports, while analysis and emission route computed member access through the same operator-overload selection path used by binary operators.

Important design choices:

- `receiver[x, y]` treats the comma-separated bracket expressions as distinct index arguments for overload matching and emission.
- `receiver[x, y] = value` resolves `operator[]=` with the assigned value first, then the dimensions: `(value, x, y)`.
- Rest parameters such as `operator[](...dimensions: int[])` and `operator[]=(value: T, ...dimensions: int[])` are matched as varargs.
- Generic class type arguments are substituted when matching class index operators, so `Array2<string>.operator[](...): T` returns `string`.

Dead end avoided: modelling `[]` as another binary operator would have leaked non-binary syntax into binary precedence, diagnostics, and enum folding. Keeping a separate `OverloadableOperator` type preserves the existing binary-expression model while still allowing one shared overload resolver.
