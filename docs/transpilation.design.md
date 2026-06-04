# MyLang Transpilation Design Notes

This document captures the current transpilation design and emitter invariants used by MyLang.

Scope:

- Orchestration: `compiler/runtime/transpile.ts`
- Emission: `compiler/runtime/emitter.ts`
- Upstream parse artifacts: `compiler/pipeline/parse.ts`
- Upstream compile artifacts: `compiler/pipeline/compile.ts`

## Pipeline Contract

`transpile(source)` follows this sequence:

1. Parse source through the shared parse phase, producing lexical/parser artifacts and honoring parser language options.
2. Analyze the recovered AST through the shared compile phase, producing semantic artifacts.
3. Return early if lexical/parser/fatal errors exist.
4. Return early if semantic issues exist.
5. Choose transpile target:
   - `optimized` (default): run lowering pass before emission.
   - `conservative`: emit directly from parsed AST.
6. Emit JavaScript (+ expression type map for long arithmetic behavior).
7. Normalize final output with `ensureTrailingSemicolon`.
8. Produce a source map payload for successful output.

The phase boundary is exposed independently:

- `parseSource(source, parserOptions)` in `compiler/pipeline/parse.ts` is the reusable tokenizer + parser entrypoint for consumers that do not need semantic analysis.
- `compileSource(source, parserOptions)` in `compiler/pipeline/compile.ts` composes the parse phase with semantic analysis.
- Low-level consumers must use the parse phase instead of rebuilding tokenizer/parser orchestration, which keeps parser mode selection and error artifacts consistent without introducing a dependency on semantic analysis.

Current contract:

- Any compile/semantic error yields:
  - `code: ""`
  - `warnings: []`
  - `errors: string[]`
- Successful transpilation yields:
  - `errors: []`
  - `warnings: []`
  - `code` with final trailing semicolon normalization.
  - `sourceMap` (Source Map v3 JSON string, line-start mapping strategy).

## Error Propagation Invariants

- Tokenizer/parser/fatal errors are reported before semantic errors.
- Semantic errors block emission entirely.
- If artifacts are unexpectedly incomplete (`ast` or `analysis` missing), transpile returns a deterministic internal-error message.

This means emit phase never runs with known invalid compile artifacts.

## Emitter Invariants

### Statement-level normalization

- `val` is emitted as `const`.
- `let`, `var`, `const` keep their JavaScript equivalent.
- Ambient declarations (`declare class`, `declare var`, declared functions) are omitted from JS output.

### Expression precedence and associativity

- Emitter computes precedence explicitly and inserts parentheses only when required to preserve AST semantics.
- Right-side grouping is preserved for left-associative operators where needed (`1 - (2 - 3)` style cases).
- Assignment left-hand wrapping protects invalid precedence interactions.

### Range lowering behavior

- In `optimized` target, `for (x of a ... b)` is lowered into a classic numeric loop (`for (let x = a; x < b; x++)`) when possible.
- In `conservative` target, loop lowering is skipped and range iteration stays generator-based.
- Standalone range expressions are emitted as generator-producing expressions.

### Literal preservation

- Regular expression literals are emitted unchanged as JavaScript regular expressions.
- Sparse array holes are preserved in emitted array literals so runtime length and `in` behavior match JavaScript/TypeScript.

### Long arithmetic behavior

- Long-typed arithmetic expressions are wrapped with `BigInt.asIntN(64, ...)` to preserve 64-bit semantics.
- Long and bigint literals are emitted as JS bigint literals (`10n`).

### Class/Member syntax emission

- Class primary constructor parameters are lowered into:
  - constructor parameters,
  - assignments to `this` when needed,
  - field declarations/method declarations as standard class members.
- Member access preserves optional/non-null operators currently represented in AST.

## Formatting and Output Shape

- Emission is structurally readable but not a full formatter pass.
- Semicolons are emitted per statement; `transpile()` applies a final trailing-semicolon guard for non-empty output.
- Import statements are emitted in standard ES module syntax for supported named imports.
- Extension properties are emitted as exported/imported receiver-mangled functions (for example, `number.milliseconds` becomes `number$$milliseconds`) and property access is lowered to a function call with the receiver as its argument.
- Whole-program emitter discovery uses the shared structural AST traversal rather than construct-specific recursive walkers, so newly introduced statement and expression containers participate automatically.

## Source Map Strategy (Current)

Current source maps are generated in transpile step with a line-start mapping strategy:

- One mapping segment per generated line.
- Each generated line start (column 0) maps to a source line start (column 0).
- Source content is embedded in `sourcesContent`.

This approach is intentionally simple and robust:

- It improves runtime stack-line attribution with low generation cost.
- Column-level precision and transformation-aware remapping are future improvements.

## Optimization Boundary (Current State)

The transpile pipeline now has an explicit lowering boundary:

- `compiler/runtime/lowering.ts` performs non-trivial AST rewrites (for example, range-loop lowering).
- `compiler/runtime/emitter.ts` focuses on JavaScript syntax emission.

Target mode controls whether lowering runs (`optimized`) or is skipped (`conservative`).

## Extension Guidance

When adding transpilation features:

1. Add or update emitter tests first for output behavior.
2. Keep precedence invariants intact when introducing new operators or expression forms.
3. If a new optimization is non-local, prefer adding an explicit lowering stage rather than ad hoc emitter branching.
4. Ensure error behavior remains fail-fast on compile/semantic issues.

Related tests:

- `compiler/runtime/emitter.test.ts`
- `compiler/runtime/transpile.test.ts`
