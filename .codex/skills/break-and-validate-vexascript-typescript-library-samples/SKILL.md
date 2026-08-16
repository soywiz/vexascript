---
name: break-and-validate-vexascript-typescript-library-samples
description: Break and validate VexaScript compatibility with TypeScript libraries by stress-testing realistic samples, real npm packages and declaration files, compiler and bundler behavior, and LSP/editor semantics. Use for focused regression hunting, unsupported TypeScript constructs, expanding existing samples, or comprehensive multi-file validation of an unmodified published library.
---

# Break and Validate VexaScript TypeScript Library Samples

Expose real compatibility gaps, reduce each failure to a focused regression,
fix the shared implementation, and preserve realistic sample coverage. Treat
published TypeScript packages and their declarations as the contract.

## Choose the validation mode

- Use **targeted regression** when asked to break one compiler, parser, emitter,
  bundler, import, or LSP surface. A focused fixture or an existing sample is
  sufficient.
- Use **full library validation** when asked to support or certify a published
  TypeScript library. Cover its applicable public families, package entry points,
  runtime behavior, multiple modules, and editor semantics systematically.

Both modes use the same reproduction, repair, and validation workflow. Full
library validation repeats it until the coverage matrix is complete.

## Non-negotiable rules

- Use the real package and exact published version. Do not edit `node_modules`,
  copy or simplify declarations, add local declaration overrides, or patch the
  dependency.
- Do not modify sample code to hide a compiler, emitter, bundler, or LSP defect.
  Reduce the defect to a focused automated test and fix the shared layer.
- Never add sample-owned `any` or `unknown` annotations, `as any`/`as unknown`
  casts, declaration overrides, or diagnostic suppressions to bypass inference or
  make compatibility checks compile. Derive input and output types from the real
  library declarations (for example, `z.input<typeof Schema>` and
  `z.output<typeof Schema>`) and fix VexaScript when those types do not resolve.
  A library declaration may itself expose `any` or `unknown`; observe that
  contract without copying the broad type into sample APIs as an escape hatch.
- Use deliberate invalid inputs only in negative runtime or diagnostic coverage.
  Keep those values structurally typed through the library's declared input type
  so invalid data does not weaken unrelated compile-time validation.
- Derive editor behavior from declarations. Never hardcode library-specific
  symbols, values, members, or completion catalogs.
- Make runnable sample additions observable through `expected.txt`, bundling, or
  LSP diagnostics; do not add dead coverage.
- Prefer extending the sample that already owns a concept over creating a sample
  for every regression.

## Establish the target

For a targeted regression, identify one realistic failing surface and reproduce
it through the same infrastructure path used by users.

For a full library validation:

1. Identify the current stable version from an authoritative source.
2. Inspect `package.json` exports, type entry points, runtime formats, peer
   dependencies, environments, and public declarations.
3. Build a coverage matrix for every applicable public family:

| Surface | Required coverage |
| --- | --- |
| Packaging | Root and documented subpaths; named, default, namespace, type-only, and re-exported imports; exposed ESM/CJS edges |
| Types | Generics, constraints/defaults/variance, overloads, aliases, conditional and mapped types, `keyof`, indexed access, literals, tuples/rest, inheritance, callbacks, and callable/constructable types used by the library |
| Runtime | Public API families, composition helpers, successful and failing inputs, errors, transformations, and stateful operations |
| Async | Promise-returning APIs, async callbacks, rejection/error paths, and orchestration |
| Modules | Declarations, inferred models, consumers, and runtime orchestration split across files with value and type imports |
| LSP | Diagnostics, hover, completion, signature selection, go-to-definition, and cross-file/package provenance |
| Targets | Node and browser/bundler behavior whenever the package claims both environments |

Record genuinely inapplicable surfaces explicitly. Do not report comprehensive
coverage while a documented public family or entry point is absent.

## Stress the real infrastructure

Prefer constructs that commonly expose TypeScript compatibility gaps:

- alias and namespace re-exports, `export *` chains, and nested type entry points;
- `typeof` queries for local and imported values;
- conditional, mapped, indexed-access, template-literal, and `infer` aliases;
- overloads, callable or constructable interfaces, and merged declarations;
- generic defaults, constraints, and variance modifiers;
- literals used in shapes, completions, and overload selection;
- contextual regular expressions or operators that can confuse tokenization;
- package export maps, ESM/CJS boundaries, and bundler resolution.

Use the real path for each symptom:

- run samples through their harness or bundling command;
- run compiler failures through the owning parser, analysis, or emitter layer;
- run editor failures through imported declarations, source roots, and the same
  analysis/LSP session used by the server.

## Reproduce and repair

For every failure:

1. Keep the realistic sample case when it is useful user-facing coverage.
2. Add the smallest automated regression that preserves the failing construct.
3. Classify the owner: tokenizer/parser, module resolution, declaration
   extraction, type checker, emitter/bundler, or LSP.
4. Fix the earliest shared layer that owns the semantics. Prefer one canonical
   path over library-specific branches or duplicated compiler/LSP logic.
5. Run the focused regression and realistic sample before expanding coverage.

Use the shared cursor-marker helper for LSP tests. Assert semantic types,
declaration provenance, and the requested editor result rather than only the
absence of diagnostics. If a type is known but hover or go-to-definition is not,
treat that mismatch as architectural drift.

## Build durable samples

Full library validation normally uses multiple files:

```text
samples/<library>/
  package.json
  pnpm-lock.yaml
  expected.txt
  schemas-or-config.vx
  models.vx
  operations.vx
  main.vx
  README.md
```

Exercise deterministic success and error paths, cross-file inferred types,
composition, callbacks, and async behavior. The README must describe the matrix
actually covered and must not claim types that compile only because consumers
avoid them.

## Completion criteria

For targeted regression mode:

- the failure has a focused automated regression;
- the shared owning layer contains the fix;
- the relevant realistic sample or infrastructure path passes.

For full library validation, additionally require:

- all applicable matrix rows and public families are represented;
- the library remains unmodified and sample output is deterministic;
- representative diagnostics, hover, completion, signature help, definition,
  and provenance work through the real editor session.

For both modes, run focused tests, `pnpm test`, and
`pnpm cli vexa testFixtures/sample.vx`. Validate browser-facing changes in a real
browser. Update `docs/file.structure.md` for new architectural pieces and add a
journal entry for reusable regression patterns, infrastructure weaknesses, and
meaningful dead ends.

Before declaring coverage complete, search modified samples for `any`, `unknown`,
casts, suppressions, and local declaration shims. Every occurrence must come
from the unmodified library contract or a focused negative test, never from a
sample-side compatibility workaround.
