---
layout: blog-post.njk
title: Faster Pixi rebuilds with `vexa serve`
date: 2026-07-22
category: Developer experience
summary: Reusing compiler and bundler data reduced repeated Pixi rebuilds from about 200 ms to about 50 ms while keeping safe cache invalidation.
tags: blog
permalink: /blog/pixi-incremental-serve.html
---

On July 22, 2026, repeated edits to the Pixi sample took 212 ms and 201 ms to
rebuild. The development server stayed open, but it still repeated work for
unchanged dependencies.

Commit `98eb0b17` added reusable compiler and bundler data to the serve
session. Rebuilds then measured 52 ms and 45 ms.

## **Measuring the rebuild**

The CLI now reports time spent parsing, analyzing, generating code, and running
the full build. These timings are available for normal build commands, not only
for the Pixi sample.

| Scenario | Parse | Analysis | Generate code | Total |
| --- | ---: | ---: | ---: | ---: |
| Initial Pixi bundle | 2 ms | 94 ms | 5 ms | 1,831 ms |
| First rebuild | 1 ms | 83 ms | 2 ms | 93 ms |
| Later rebuilds | included | included | included | 52 ms / 45 ms |
| Previous rebuilds | not recorded separately | not recorded separately | not recorded separately | 212 ms / 201 ms |

The initial total includes package loading, module resolution, bundle assembly,
and file writes. This is why the three compiler phases do not add up to the
full 1,831 ms.

## **Data kept between edits**

The serve session keeps data only while its inputs remain unchanged.

| Reused data | When it remains valid |
| --- | --- |
| Module type information | Module source and imports have not changed |
| DOM and library declarations | Declaration files are unchanged |
| Dependency map | Imports and project settings are unchanged |
| Code-generation metadata | Output settings are compatible |
| Generated vendor module text | Package source and output settings are unchanged |

Caching the final vendor text matters because Pixi produces large generated
modules. Keeping only the parsed syntax tree would still regenerate the same
large strings after every edit.

## **Cache invalidation**

The compiler reuses less data when it cannot prove that the cache is safe.

| Change | Response |
| --- | --- |
| Edit only the entry module body | Rebuild the entry and reuse dependencies |
| Change entry imports | Resolve the affected module graph again |
| Change another source file | Clear broader project data |
| Change compiler or project settings | Start a new session state |
| Leave a package unchanged | Reuse its analysis and generated factory |

The file watcher delay was also reduced from 75 ms to 20 ms after event
grouping became reliable. The reported total includes this user-visible delay,
while compiler phase timings do not.

## **Why the browser still reloads**

The compiler rebuild is incremental, but the browser performs a full reload.
Pixi applications own a canvas, renderer, ticker callbacks, GPU resources, and
event handlers. Loading a new module without disposing the old application
would leave both copies running.

Safe hot-module replacement needs an application cleanup API. VexaScript does
not guess how each program should release its resources. A full reload provides
that cleanup.

## **Result and limits**

Repeated entry edits became about four times faster on the measured machine.
The result does not mean every project rebuild takes 50 ms, and it does not
remove cold-start work.

The useful change is that the server now has explicit cache keys and
invalidation rules. Future slowdowns can also be assigned to a measured build
phase instead of appearing only as one total time.
