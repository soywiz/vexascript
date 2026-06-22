---
name: break-vexascript-with-samples
description: Stress-test VexaScript by intentionally trying to break the compiler, parser, type checker, emitter, or LSP hover/go-to-definition behavior with realistic samples, library typings, node_modules packages, and editor-session reproductions; use when asked to add or expand samples with code that verifies previously broken behavior, import problematic libraries, find unsupported TypeScript cases, or turn a real sample/library failure into compiler and LSP fixes.
---

# Break VexaScript With Samples

Use this skill to find real gaps instead of polishing already-covered paths. The goal is to expose a compiler or LSP failure with realistic code, reduce it to a focused regression test, fix the shared implementation, and keep the sample as broad coverage only when it represents a useful user-facing scenario.

When a bug was already found and fixed, grow an existing runnable sample with a small realistic use of that exact surface whenever it is useful user-facing coverage. Samples should accumulate representative "this used to break" code, so the project keeps exercising real editor/runtime paths instead of only hidden unit tests.

## Workflow

1. Pick a realistic stress target:
   - existing samples such as `samples/zod`, `samples/pixi`, `samples/react-query`, `samples/threejs`, `samples/node`;
   - a new small sample under `samples/<name>` when a library pattern is worth keeping as broad coverage;
   - a synthetic `node_modules` fixture inside an LSP/compiler test when the failure can be isolated without a full sample.
2. Try to break one concrete surface:
   - parser support for TypeScript declaration syntax;
   - imported type resolution from packages, re-exports, namespaces, default exports, or aliases;
   - hover/go-to-definition consistency for any symbol that already has a known type;
   - completions for literal unions, object members, call signatures, or generic-derived members;
   - emitted JavaScript for constructs used by samples;
   - diagnostics that should match what VS Code users see.
3. Reproduce through the real infrastructure path before patching:
   - for LSP, use imported declarations, source roots, and the same resolver entrypoint used by the server;
   - for samples, run the same sample harness or bundling path;
   - for compiler failures, call the parser/type checker/emitter layer that owns the behavior.
4. Add the smallest automated regression first.
   - Prefer a focused compiler or LSP test over relying only on a large sample.
   - Use `sourceWithCursor` marker tests for hover/definition cursor cases.
   - Keep a sample update only when the sample itself is valuable user-facing coverage.
   - If the bug came from a real sample or user-visible editor flow, also add a compact sample use that would have failed before the fix.
   - For runnable samples, make the new code affect `expected.txt` or browser bundling/LSP diagnostics instead of sitting as dead code.
   - Prefer extending an existing sample that already owns the concept over creating a new sample for every regression.
5. Fix the shared layer, not the symptom wrapper.
   - Parser bugs belong near parsing/AST conversion.
   - Type knowledge belongs in analysis/type resolution.
   - Declaration origin and cross-file navigation belong in shared import/declaration resolvers.
   - LSP wrappers should mostly adapt cursor/range/request shape.
6. Validate narrowly first, then fully:
   - run focused tests for the changed area;
   - run `pnpm test`;
   - run `pnpm cli vexa testFixtures/sample.vx`.

## Stress Patterns

Prefer library constructs known to expose TypeScript compatibility gaps:

- alias re-exports such as `export type { TypeOf as infer }`;
- namespace imports and namespace values such as `import { z } from "zod"` plus `z.infer`;
- `typeof` type queries pointing at local values or imported values;
- conditional, mapped, indexed-access, template-literal, and infer-heavy aliases;
- overloaded functions, callable interfaces, constructor interfaces, and merged declarations;
- generic defaults and constrained generic parameters;
- literal unions used as object property values, completion sources, or overload selectors;
- package `types` fields, nested declaration entrypoints, and `export *` chains.

## Expected Fix Standard

If a type is available, hover and go-to-definition should usually be available too. Treat mismatches as architectural drift unless there is a clear language-server limitation.

Do not add one-off compatibility layers for each library. Prefer one canonical path that carries enough symbol origin data for type checking, hover, definition, completion, and diagnostics to agree.

Do not modify samples merely to make tests pass. Sample changes must reflect intended VexaScript usage.

## Completion Criteria

- The failure is demonstrated by an automated regression test that fails before the fix.
- The implementation fix is in the shared compiler/LSP layer that owns the behavior.
- Existing broad samples still pass.
- `pnpm test` passes.
- `pnpm cli vexa testFixtures/sample.vx` passes.
- Add or update a journal entry when the failure reveals a reusable bug pattern, architectural drift, or investigation dead end.
