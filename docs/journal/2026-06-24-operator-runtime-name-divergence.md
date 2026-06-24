# Two operator→runtime-name maps that disagreed (cross-module overload bug)

## Symptom

A `.vx` module that defines an extension operator overload and relies on the
implicit export of its top-level declarations could not be called from another
module for several operators. With separate-module output
(`bundleModuleGraphAsModules`, CommonJS), the dependency emitted:

```js
function Vec2$$operator$star$$Vec2($this, other) { ... }   // the definition
exports.Vec2$$operator$multiply$$Vec2 = Vec2$$operator$multiply$$Vec2; // the export
```

`Vec2$$operator$multiply$$Vec2` is never defined, so loading the dependency
throws `ReferenceError` (or, depending on shape, the consumer imports
`undefined`). Single-file `transpile` hid the bug entirely because the inlined
path is internally self-consistent (it never consults the export planner).

## Root cause: parallel maps, classic divergence

There were **two** independent operator→method-name tables:

- `compiler/runtime/emitter.ts` `OPERATOR_METHOD_NAMES` — used to emit the
  operator definitions, call sites, and explicit export statements. `*` →
  `operator$star`, `<` → `operator$less`, `||` → `operator$logicalOr`, ...
- `compiler/runtime/implicitExports.ts` `operatorBaseRuntimeName` — used only to
  build the **implicit** `.vx` export plan. `*` → `operator$multiply`, `<` →
  `operator$lessThan`, `||` → `operator$or`, ...

They agreed for `+ - ** << >> >>> == != === !== & | ^ [] []=` and (via the
emitter's `operator$<sanitized>` fallback) for `in is instanceof`, but disagreed
for `* / % < > <= >= || && ??`. The emitter is the side that actually emits the
function, so its names are canonical; the export planner was emitting export
lines for names that never existed.

This is the same shape as the pixi/zod precedence regressions: one behavior
implemented twice, the copies drift, and a bug fixed/working in one copy stays
broken in the other. `<=>` (spaceship) had just been added to both maps with the
same name, which is exactly why the divergence in the *older* operators was easy
to overlook — the most recently touched entry looked consistent.

## Fix

Collapsed both tables into one source of truth,
`compiler/runtime/operatorNames.ts`, exporting `OPERATOR_METHOD_NAMES`,
`operatorBaseRuntimeName`, and the shared `sanitizeManglePart` (the fallback
needs it; it was itself duplicated as `sanitizeManglePart` /
`sanitizeRuntimeManglePart`). The emitter and the export planner now both read
from it, so the exported name is always exactly the emitted name. Old local maps
and the duplicated sanitizer were deleted, not layered over.

## Lesson

When the same conceptual mapping (operator → mangled name) is needed by an
emit-side and an export-side, they are not "different, never-cross-referenced
purposes" — they meet at module boundaries. Any such pair must share one table.
Guard it with a *cross-module* test (`bundleModuleGraphAsModules` + execute, or
at minimum assert that the dependency's `exports.X = X` name equals the
`function X(...)` it defines and the consumer's `require`d name). A single-file
transpile test will pass even while the cross-module path is broken.
