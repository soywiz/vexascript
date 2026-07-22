---
layout: blog-post.njk
title: The native compiler completes its first self-host
date: 2026-07-19
category: Compiler milestone
summary: A VexaScript compiler running as native C++ emitted the next complete compiler translation unit for the first time.
tags: blog
permalink: /blog/native-self-hosting.html
---

On July 19, the native executable built from `cli/cli.ts` completed its first full self-hosting roundtrip: the C++ compiler ran the ordinary CLI and emitted the next compiler translation unit.

The first successful unoptimized pass took 171 seconds and produced about 6.6 MB of C++. That number was less important than what the run exercised. The native process parsed the complete compiler project, performed semantic work, traversed the real module graph, and emitted the compiler again through the same public CLI used for application code.

Several failures only appeared at this scale. A missing UTF-16 overload made `charCodeAt` convert the entire source string to UTF-8 and back for every character, turning tokenization effectively quadratic. Native async child-process execution had to copy arguments before moving work to a background thread, because a worker cannot safely retain pointers into the managed heap. Recursive type-analysis callbacks also needed explicit static return contracts so generated C++ would not let missing dynamic values enter the compiler's type model.

Later rounds added TypeScript semantic validation, byte-stable output across hosts, and repeated-generation checks. The milestone changed the native backend from a language demo into a compiler capable of rebuilding the tool that produced it.
