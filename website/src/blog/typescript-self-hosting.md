---
layout: blog-post.njk
title: VexaScript compiles itself
date: 2026-06-17
category: Compiler milestone
summary: A technical account of the complete TypeScript-to-JavaScript bootstrap, its false-positive traps, and the invariants that made the result credible.
tags: blog
permalink: /blog/typescript-self-hosting.html
---

Commit `a1c776d6` on June 17, 2026 introduced VexaScript's first complete self-hosting path. “Self-hosting” is easy to claim imprecisely, so this post records what was actually compiled, how the generated compiler was isolated from the source compiler, and which failures appeared only when the full CLI graph became the input.

## **What counted as self-hosting**

The target was `cli/cli-bin.ts` and its complete local dependency graph, not a reduced tokenizer or a hand-selected parser subset. The generated JavaScript had to start as a standalone Node.js CLI, compile the same graph again, and run the normal repository fixture.

| Requirement | What the bootstrap exercised |
| --- | --- |
| Source language | The compiler's real `.ts` sources, not rewritten `.vx` copies |
| Front end | Tokenization, parsing, binding, semantic metadata, lowering |
| Back end | JavaScript emission and source-module assembly |
| Module system | Local imports, `baseUrl`, dotted basenames, package resolution, Node externals |
| Runtime | The generated command-line program under Node.js |
| Convergence | Three generated compiler generations with identical bytes and SHA-256 |
| End-to-end check | The last generation compiled and ran `testFixtures/sample.vx` |

The three-pass shape matters. A compiler that can produce one executable-looking file has not necessarily preserved the semantics required to compile itself again. Byte convergence makes accidental generation-dependent drift visible.

```text
TypeScript source compiler
  -> generation 1 JavaScript compiler
  -> generation 2 JavaScript compiler
  -> generation 3 JavaScript compiler
  -> identical generation 2/3 bytes
  -> compile and execute the normal CLI fixture
```

The repository exposes this as `pnpm self-host`; it is also covered by `cli/selfHost.test.ts` instead of living as a one-off release script.

## **The false success that had to be eliminated**

The source CLI contains a development convenience: when it finds the repository's TypeScript CLI and `tsx`, it can delegate to that source entrypoint. Executing a generated compiler from the repository root therefore looked healthy even when the generated code was not doing the work.

The bootstrap now runs each generated compiler from an isolated output directory. That changes the validation from “the command eventually produced output” to “this generated artifact resolved and executed its own bundled implementation.” This isolation rule is one of the most important pieces of the test because a fallback can otherwise make every later generation a false positive.

## **Failures exposed by the complete graph**

Small emitter fixtures did not cover the interactions below. They appeared because the compiler itself combines advanced TypeScript syntax, filesystem-independent module resolution, Node-specific entrypoints, and large generated functions.

| Failure | Visible symptom | Actual boundary | Fix |
| --- | --- | --- | --- |
| Type-wrapped object literal | Invalid concise arrow output | Parenthesization ran before type-only wrappers were erased | Detect object literals through `as const` and related wrappers |
| Lost `baseUrl` | Internal `compiler/...` imports became externals | Project loading read `tsconfig.json` but discarded resolution context | Carry `baseUrl` into the shared resolver |
| Dotted basename | `ecmascriptDeclarations.shared.ts` was not found | The resolver treated the last dot as a final extension | Probe recognized source suffixes even for dotted basenames |
| Browser bundle under Node | Failure on `node:child_process` | Browser bundles intentionally reject Node externals | Add an explicit Node bundle platform using the existing `createRequire` bridge |
| In-repository execution | Generated passes appeared to work when broken | Development delegation selected the source CLI | Execute generations from isolated directories |

These are useful compiler failures because none was “special support for compiling VexaScript.” Each correction tightened a general path used by ordinary TypeScript projects: type erasure, project configuration, module probing, or runtime platform selection.

## **Why transpile-only was initially explicit**

At this stage, VexaScript's own semantic checker did not model every advanced TypeScript declaration used by the compiler and Node.js typings. Treating every false positive as an emitter failure would have mixed two separate questions:

1. Can the compiler parse, lower, bundle, and emit a correct TypeScript program?
2. Does VexaScript's checker implement the complete TypeScript type system?

The first bootstrap used an explicit transpile-only boundary while TypeScript's `tsc` remained the semantic authority. Later work removed that bootstrap flag by running `tsc --noEmit` for `.ts`/`.tsx` projects and then reusing VexaScript's binding, inference, lowering, and emission artifacts. `.vx` inputs continue to use VexaScript diagnostics.

## **The evidence attached to the milestone**

| Git fact | Value |
| --- | --- |
| Commit | `a1c776d6` — `Support self-hosted TypeScript compilation` |
| Date | 2026-06-17 01:46 +02:00 |
| Initial change size | 8 files, 127 insertions, 45 deletions |
| Generated passes | 3 |
| Convergence check | Byte identity plus SHA-256 identity |
| Final functional check | Normal VexaScript CLI fixture compiled and executed |

The technical value of self-hosting is not circular prestige. It provides a large, adversarial integration test whose input uses the same parser, analyzer, resolver, emitter, async I/O, and bundler code that is under test. When that graph converges across generations, representation bugs that survive ordinary unit fixtures become much harder to hide.
