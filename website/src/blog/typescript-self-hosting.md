---
layout: blog-post.njk
title: How VexaScript compiles itself to JavaScript
date: 2026-06-17
category: Compiler milestone
summary: VexaScript can bundle its TypeScript compiler as JavaScript, run the generated compiler, and produce stable output across three generations.
tags: blog
permalink: /blog/typescript-self-hosting.html
---

Commit `a1c776d6` added the first complete JavaScript self-hosting test on
June 17, 2026. The test compiles the real TypeScript CLI, runs the result, and
uses that generated compiler to compile itself again.

## **How the test works**

The input is `cli/cli-bin.ts` and all of its local dependencies. It is not a
smaller compiler made only for the test.

```text
TypeScript source compiler
  -> JavaScript compiler 1
  -> JavaScript compiler 2
  -> JavaScript compiler 3
  -> compare compiler 2 and 3
  -> compile and run testFixtures/sample.vx
```

| Check | Purpose |
| --- | --- |
| Full CLI graph | Covers the real parser, analyzer, resolver, and emitter |
| Isolated output directory | Prevents a fallback to the source CLI |
| Three generations | Finds output that changes after each compilation |
| Byte and SHA-256 comparison | Requires stable compiler output |
| Final fixture run | Confirms that the last compiler works |

The repository runs this workflow with `pnpm self-host` and covers it in an
automated test.

## **Removing a false success**

The development CLI can delegate to the source TypeScript entrypoint when it
runs inside the repository. This made a broken generated compiler appear to
work.

Each generated compiler now runs from an isolated directory. It cannot find the
development entrypoint, so the generated bundle must do the work itself.

## **Problems found by the full compiler**

| Problem | Fix |
| --- | --- |
| An object literal inside `as const` produced invalid arrow syntax | Check through type-only wrappers before adding parentheses |
| `baseUrl` imports became external packages | Keep `baseUrl` in project resolution data |
| Dotted filenames were not found | Probe known source extensions after dotted basenames |
| A Node build rejected `node:child_process` | Add an explicit Node bundle platform |
| Generated compilers used the source CLI | Run every generation in isolation |

These fixes also help ordinary TypeScript projects. None is special handling
for the compiler source.

## **TypeScript remains the semantic checker**

At first, self-hosting used an explicit transpile-only mode because VexaScript
did not understand every advanced TypeScript type in the compiler and Node.js
declarations.

The current flow runs `tsc --noEmit` for `.ts` and `.tsx` projects. After that
check passes, VexaScript performs the work needed for binding, lowering,
bundling, and JavaScript generation. `.vx` files still use VexaScript's own
diagnostics.

The initial change touched eight files, with 127 additions and 45 deletions.
Its main value is the integration test: the compiler must preserve enough of
its own behavior to reproduce a stable compiler three times.
