# Node-backed VexaScript test runner

## Context

The website documented `test("name") { ... }`, but the CLI injected an
`@JsInline` helper that only accepted one callback argument. The injected
`assert` also expanded to a statement-level `if`; when used inside a concise
brace lambda, that produced invalid JavaScript such as `=> if (...)`.

## What worked

The CLI now compiles discovered `.test.vx` files to temporary sibling ES
modules, imports Node's `node:test` and `node:assert/strict`, and invokes one
`node --test` process for the discovered files. Node owns test registration,
names, async behavior, reporting, filtering flags, and the exit code.

The VexaScript compiler receives embedded ambient declarations for `test`,
`VexaTestContext`, and `assert`, so test code is type-checked without asking
every project to configure `@types/node`. Generated files are removed after
the runner exits, including compilation and failure paths.

## Dead ends and evidence

Keeping the old inline runtime would have required reproducing Node's test
registration and reporting in VexaScript. It also could not fix the concise
lambda problem without making the generic emitter understand every possible
statement-shaped inline template. Using Node's runner directly removes both
parallel paths.

When the CLI tests themselves spawned `node --test`, Node inherited
`NODE_TEST_CONTEXT` and treated the child as a recursive test invocation,
skipping it. Clearing that marker only for the child runner preserves the
normal environment for all other CLI subprocesses.

## Guardrails

- Keep the generated Node imports and the embedded VexaScript declarations in
  the same test-runner preparation path.
- Resolve explicit imports before compiling test sources. The single-file test
  path must use the same imported-symbol resolver as the runtime module graph;
  otherwise an explicit `node:test` binding can degrade to `unknown` and let
  the injected test declaration win overload selection.
- Only inject the runtime `test` and `assert` imports when the source does not
  already import those local names. Emitting both creates duplicate ESM
  bindings even when type checking succeeds.
- Ambient function/namespace merges can span multiple namespace blocks.
  Function parameter aliases such as Node's `test.TestFn` must resolve against
  the combined bodies of every matching namespace declaration.
- Forward Node test flags before generated file paths, including separate
  values for flags such as `--test-name-pattern` and `--test-reporter`.
- Do not let the test runner's temporary generated modules remain beside user
  source files after any failure.
