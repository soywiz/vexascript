# Zod compatibility sample

This sample uses the published Zod package without patches or local declaration
overrides. Its modules exercise the main compatibility surfaces that commonly
stress a TypeScript-derived compiler:

- package entry points, namespace exports, type-only imports, and cross-file aliases;
- primitives, formats, defaults, optional and nullable fields;
- strict objects, `pick`, `partial`, `required`, records, arrays, tuples, maps, and sets;
- literals, enums, unions, discriminated unions, and intersections;
- `z.infer`, `z.input`, and `z.output` across module boundaries;
- coercion, transforms, refinements, catch values, JSON values, and async parsing;
- `parse`, `safeParse`, typed errors, and deterministic runtime output.

`main.vx` is the executable entry point. `expected.txt` is checked by the sample
harness.
