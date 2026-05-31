# MyLang Transpilation Design Notes

This document captures the current transpilation design and emitter invariants used by MyLang.

Scope:

- Orchestration: `compiler/runtime/transpile.ts`
- Emission: `compiler/runtime/emitter.ts`
- Upstream compile artifacts: `compiler/pipeline/compile.ts`

## Pipeline Contract

`transpile(source)` follows this sequence:

1. Compile source to shared artifacts (`ast`, parser issues, semantic issues, etc.).
2. Return early if lexical/parser/fatal errors exist.
3. Return early if semantic issues exist.
4. Emit JavaScript from AST (+ expression type map for long arithmetic behavior).
5. Normalize final output with `ensureTrailingSemicolon`.

Current contract:

- Any compile/semantic error yields:
  - `code: ""`
  - `warnings: []`
  - `errors: string[]`
- Successful transpilation yields:
  - `errors: []`
  - `warnings: []`
  - `code` with final trailing semicolon normalization.

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

- `for (x of a ... b)` is optimized into a classic numeric loop (`for (let x = a; x < b; x++)`) when possible.
- Standalone range expressions are lowered to generator-producing expressions.

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

## Optimization Boundary (Current State)

Current design intentionally mixes:

- direct code emission, and
- targeted lowering/optimizations (range-for optimization, long wrapping)

inside the emitter.

This is functional but creates coupling between optimization policy and string emission. A future refactor can introduce an explicit lowering/optimization IR pass boundary before final JS emission.

## Extension Guidance

When adding transpilation features:

1. Add or update emitter tests first for output behavior.
2. Keep precedence invariants intact when introducing new operators or expression forms.
3. If a new optimization is non-local, prefer adding an explicit lowering stage rather than ad hoc emitter branching.
4. Ensure error behavior remains fail-fast on compile/semantic issues.

Related tests:

- `compiler/runtime/emitter.test.ts`
- `compiler/runtime/transpile.test.ts`
