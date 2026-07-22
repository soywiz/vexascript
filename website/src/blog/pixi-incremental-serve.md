---
layout: blog-post.njk
title: Pixi serve rebuilds fall from 200 ms to about 50 ms
date: 2026-07-22
category: Developer experience
summary: Incremental analysis and pre-rendered vendor modules make entry-only Pixi edits rebuild roughly four times faster.
tags: blog
permalink: /blog/pixi-incremental-serve.html
---

On July 22, the Pixi sample became the proving ground for a genuinely incremental `vexa serve` loop.

Editing its small `html.vx` entry had cost 212 ms and 201 ms even after the initial bundle. Profiling showed that package resolution was no longer the main problem. The compiler still rebuilt declaration-node indexes and module typing contexts for stable DOM and Pixi declarations, while the bundle writer regenerated the same multi-megabyte vendor factories on every edit.

Long-running serve sessions now retain stable declaration identity, type-checker declaration sets, module typing contexts keyed by import fingerprints, emitter runtime metadata, resolved dependency maps, and pre-rendered vendor module factories. An entry-only edit can reuse all of that state while a changed import or non-entry file conservatively invalidates the relevant cache. The watcher debounce also fell from 75 ms to 20 ms once change coalescing became reliable.

Steady-state real watcher runs measured 52 ms and 45 ms, approximately four times faster than the original loop. Serve output now separates parsing, analysis, and emission from the end-to-end bundle time so future profiles show whether the cost sits in the compiler or around it.

Live reload remains a deliberate full page reload. Re-importing a Pixi entry without a disposal contract would leave the old application, canvas, and ticker alive; safe HMR needs explicit lifecycle ownership first.
