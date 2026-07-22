---
layout: blog-post.njk
title: VexaScript gains a native C++ backend
date: 2026-07-16
category: Native compilation
summary: A second backend began reusing the existing parser, analysis, diagnostics, and lowering pipeline to produce native executables.
tags: blog
permalink: /blog/native-cpp-backend.html
---

On July 16, VexaScript gained its first native C++ backend and executable workflow.

The important architectural decision was to keep C++ as another terminal backend, not as a separate compiler. Parsing, binding, type analysis, diagnostics, and lowering stay shared with JavaScript emission. The browser-compatible compiler produces a translation unit; the CLI-only adapter handles the compiler process, cached native dependencies, and linking.

The initial runtime used Oilpan for managed objects so generated classes, arrays, closures, promises, and suspended computations could retain language-level reference semantics without manual ownership at every call site. Even the first examples found useful backend boundaries: range loops had to preserve their analyzed `int`, `long`, or `number` type, class construction needed runtime-aware allocation, and arrays needed managed identity rather than C++ value copies.

The public commands established on that day remain the core workflow:

```text
vexa cpp program.vx -o program.cpp
vexa executable program.vx -o program
```

What began as a small native example quickly became a second execution target for the full language. That shared-pipeline choice is what later made native self-hosting and cross-backend FFI possible without duplicating the front end.
