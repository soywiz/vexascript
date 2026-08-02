---
layout: blog-post.njk
title: How the VexaScript compiler self-hosts in native C++
date: 2026-07-19
category: Compiler milestone
summary: A generated native compiler can compile the VexaScript compiler again, exposing performance, type, and asynchronous I/O problems that small samples missed.
tags: blog
permalink: /blog/native-self-hosting.html
---

Commit `58703ec2` completed the first native self-hosting run on July 19,
2026. A VexaScript compiler generated as C++ loaded the real `cli/cli.ts`
project and generated the next C++ compiler.

## **What the test runs**

The native executable does not call Node.js to compile the project. It loads
the TypeScript files, runs the compiler, builds the module graph, and writes a
new C++ translation unit.

| First run | Value |
| --- | ---: |
| Commit | `58703ec2` |
| Generation time without optimization | 171 seconds |
| Generated C++ file | about 6.6 MB |
| Change size | 29 files, 1,401 additions, 596 deletions |
| Entrypoint | `cli/cli.ts` |

This test covers much more code than a native sample. It combines recursive
types, declarations, modules, asynchronous files, collections, and a large
amount of generated output.

## **Why the first run appeared to hang**

The tokenizer calls `charCodeAt` for each character. C++ selected an old
`std::string` overload, which converted the full UTF-16 source to UTF-8 and
back for every character.

One character lookup should take constant time. Instead, each lookup processed
the whole file, so tokenizing a file of N characters took about N squared work.
A direct UTF-16 overload fixed the problem.

This bug shows why a runtime type change must update all related helper
functions. Leaving one old overload can produce valid but very slow C++.

## **Asynchronous TypeScript checks**

The CLI uses `tsc --noEmit` to validate TypeScript projects. Waiting for that
process on the main runtime thread would block timers and Promises. The native
adapter runs the process on a worker and posts the result back to the event
loop.

The worker receives copied command data. It does not keep raw pointers to
Oilpan-managed objects. The same rule is used for blocking FFI calls.

## **Errors found in later compiler generations**

The first generated compiler could run even when it emitted incorrect types
for the next compiler.

| Problem | Fix |
| --- | --- |
| `map` callbacks were emitted as returning `void` | Keep the declared callback result type |
| Missing values entered `AnalysisType[]` | Normalize them at `unionType` |
| Recursive generic maps lost their element type | Add explicit `AnalysisType` annotations |
| Missing values became invalid `WeakMap` keys | Reject missing operands before cache access |
| Optional collection receivers lost optional behavior | Use the shared optional-call code |

Adding a null check at each crash site was not enough. The compiler now fixes
the producer of the bad value and also checks important type-system entry
points.

## **What self-hosting proves**

For `.ts` and `.tsx` files, TypeScript remains responsible for the full
semantic check. VexaScript then reuses its parsed and analyzed data to generate
C++. `.vx` files use the VexaScript checker.

Later commits made repeated native compiler output byte-for-byte stable. The
test is useful because a wrong type or unsafe pointer may survive in a normal
program but fail when the generated program must compile itself again.
