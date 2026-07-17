# Complete The Native Async Runtime

## Status

* [x] Completed

## Context

The native runtime has a single-threaded microtask/timer event loop, task-backed
async and sync functions, Promise construction and chaining, and async generators.
Anonymous callbacks remain synchronous, timers accept only zero-argument
callbacks, the Promise API is incomplete, and the loop has no native I/O sources.

## Goal

Make async behavior composable across named callables, closures, promises, timers,
generators, and native I/O while retaining one scheduler and one task state model.

## Scope

* [x] Support async and sync arrow functions and anonymous function expressions.
* [x] Preserve captured managed values across suspended anonymous callables.
* [x] Support timer callback arguments and async timer callbacks.
* [x] Implement `Promise.race`, `Promise.allSettled`, and `Promise.any`.
* [x] Complete thenable assimilation and nested-task flattening semantics.
* [x] Preserve arbitrary rejection values and useful error context.
* [x] Define cancellation and shutdown behavior for live tasks, intervals, and I/O.
* [x] Add event-loop sources for asynchronous files, sockets, HTTP, processes, or
  streams through platform adapters without adding Node APIs to compiler modules.
* [x] Keep timers, promises, generators, and I/O on one microtask continuation
  path rather than introducing parallel schedulers.

## Acceptance Criteria

* [x] Async closures can be passed, returned, stored, and awaited.
* [x] Promise combinators match deterministic JavaScript ordering and settlement
  behavior, including rejection paths.
* [x] Timer arguments and async callbacks work without blocking the event loop.
* [x] At least one real native asynchronous I/O operation integrates with tasks.
* [x] Runtime shutdown does not leak or resume callbacks after heap destruction.

## Tests

* [x] Add focused task and Promise settlement-order tests.
* [x] Add timer argument, async callback, cancellation, and shutdown tests.
* [x] Add native compile-and-run tests for async closures and one I/O adapter.
* [x] Add GC tests for suspended callbacks and rejection continuations.
* [x] Run `pnpm test`.
* [x] Run `pnpm cli vexa testFixtures/sample.vx`.

## Completion Summary

One runtime scheduler now drives microtasks, timers, promises, sync/async
closures, generators, and asynchronous file reads. Nested tasks flatten,
combinators preserve ordering and arbitrary rejection values, timer cancellation
is deterministic, and shutdown clears callbacks and I/O pollers before Oilpan is
destroyed. Native smoke, sanitizer, and forced-GC modes cover the integration.

## Related Files

* `native/runtime.cpp`
* `compiler/runtime/cppEmitter.ts`
* `compiler/runtime/lowering.ts`
* `cli/io.ts`
* `samples/native-language-smoke/`
