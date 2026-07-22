---
layout: blog-post.njk
title: VexaScript compiles itself
date: 2026-06-17
category: Compiler milestone
summary: The complete TypeScript compiler graph reached a byte-stable JavaScript self-hosting cycle.
tags: blog
permalink: /blog/typescript-self-hosting.html
---

On June 17, VexaScript crossed its first self-hosting boundary: the compiler could compile its own TypeScript sources to JavaScript and use that generated compiler for the next generation.

This was deliberately not a reduced parser demo. The target was the complete CLI graph, including parsing, semantic metadata, JavaScript emission, local module resolution, package bundling, Node.js externals, and the command-line runtime. Three generations converged to identical bytes and the final generation successfully compiled and ran the ordinary CLI fixture.

The difficult part was not printing JavaScript. Self-hosting exposed integration assumptions that smaller fixtures had missed: object literals wrapped in type-only expressions needed parentheses in concise arrow bodies, the loaded `tsconfig.json` had to preserve `baseUrl`, and dotted source basenames still needed extension probing. Running the generated compiler outside the repository was also essential, because executing it beside the source CLI could silently delegate back to the original implementation and produce a false success.

The resulting `pnpm self-host` workflow became a durable regression test. It proves that VexaScript can process a real TypeScript application at compiler scale, and that the output is capable of repeating the same work without falling back to the source compiler.
