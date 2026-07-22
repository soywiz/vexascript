# Incremental `vexa serve` rebuild latency

## Symptom

Editing `samples/pixi/html.vx` rebuilt the browser bundle in roughly 200 ms even though the entry file is small and package declarations had already been parsed. The live-reload debounce added another 75 ms before compilation began.

## Investigation

Reusing only the resolved `node_modules` module graph did not materially improve the hot rebuild. An in-process Pixi profile remained around 130 ms because two later stages still traversed stable declarations:

- `TypeChecker` rebuilt declaration-node sets and type indexes for DOM and Pixi.
- JavaScript emission rebuilt runtime metadata by walking ambient and imported declarations.

The bundle writer also regenerated factory strings and paths for every cached Pixi dependency, producing the same multi-megabyte vendor text on each edit.

CPU sampling was important here. Filesystem and package-resolution work looked like the likely cause, but after the first build those paths were already relatively cheap. Adding another package-resolution cache without profiling would have optimized the wrong layer.

## Resolution

Long-running serve sessions now retain:

- module typing contexts keyed by a stable import fingerprint;
- ambient declaration array identity;
- emitter runtime seeds for stable ambient and imported declarations;
- declaration-node sets used by the type checker;
- resolved dependency maps and pre-rendered module factory strings for the vendor graph.

The cache is cleared conservatively when a non-entry watched file changes or when module-resolution configuration changes. An entry-only edit can reuse the context when its imports are unchanged; changing imports produces a new fingerprint and rebuilds the context.

The rebuild debounce was reduced from 75 ms to 20 ms because the watcher now coalesces pending paths, checks file versions, and drains changes that arrive during an active rebuild.

## Result

The real Pixi watcher measured 52 ms and 45 ms on steady-state rebuilds, down from 212 ms and 201 ms. The first rebuild after the large initial compile can still be slower (about 90 ms in observed runs), primarily because of runtime warm-up and garbage collection.

Browser live reload deliberately remains a full page reload. Re-importing the Pixi entry without a disposal contract would leave the previous application, canvas, and ticker alive. A future HMR design must define ownership and cleanup before replacing the full reload.
