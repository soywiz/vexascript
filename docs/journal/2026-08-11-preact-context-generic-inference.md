# Preact Context Generic Inference

## Problem

The Preact browser sample could not use a context created by `createContext`
with the `useContext` hook from `preact/hooks`. The imported declarations use
two structurally compatible interfaces:

- `createContext<T>()` returns `Context<T>`;
- `useContext<T>()` accepts `PreactContext<T>`;
- `PreactContext<T>` extends `Context<T>` without adding members.

VexaScript reported that `Context<...>` was not assignable to
`PreactContext<T>`, even though TypeScript infers `T` through that inherited
generic relationship and accepts the structurally compatible value.

## Cause

Generic call inference only aligned named type arguments when the parameter and
argument had the same nominal name, with a dedicated `Promise`/`PromiseLike`
case. It already understood declared inheritance during assignability, but did
not use the same inheritance graph while inferring type-parameter
substitutions. As a result, the call was validated while `T` was still
unresolved.

The sample harness exposed a separate coverage gap: a sample with
`expected.txt` returned early after its console test, so a configured browser
entrypoint in the same directory was never bundled by `pnpm test`.

After the bundle compiled, the real browser exposed a second runtime gap.
`jsxImportSource: "preact"` selected classic `h`/`Fragment` calls but did not
emit bindings for those names, so code written for the automatic JSX runtime
failed with `ReferenceError: h is not defined` unless it added a manual import.

## Resolution

- Generic inference now searches both named types' declared supertype chains
  and aligns matching inherited generic shapes before inferring substitutions.
- A focused node_modules regression reproduces the split `preact` and
  `preact/hooks` declaration entrypoints.
- The Preact browser sample now demonstrates a typed nullable context,
  `useContext`, `useMemo`, a provider, and three consumers sharing one counter.
- Preact `jsxImportSource` now emits collision-safe internal bindings for the
  classic `h` and `Fragment` exports in every module that actually contains
  JSX, allowing automatic-runtime-style source without a manual `h` import.
- The sample harness now treats console execution and configured bundling as
  independent checks, so samples can and should receive both forms of
  coverage.

## Investigation Notes

The original sketch also produced two unrelated, valid strict-type errors:
`createContext(null)` fixes the context value type to `null`, and
`document.getElementById()` can return `null`. Suppressing those diagnostics
would have weakened the type checker and obscured the actual imported-interface
inference bug. The sample instead supplies an explicit nullable context type
and uses non-null assertions at the provider and DOM boundaries.

Testing only the existing console half of `samples/preact` was also a dead end:
it never loads `html.vx`, so it could stay green while the requested browser
code failed to compile. The real bundle command revealed the problem, and the
harness change preserves that route as regression coverage.

Likewise, treating a successful bundle as proof of browser correctness was
insufficient. The generated bundle contained a free `h` reference and only
failed when executed. A focused module-graph regression now checks the runtime
binding, and the final browser validation confirmed that one click updates all
three context consumers with no console errors.

The full-suite reruns also exposed a pre-existing concurrency hazard in Monaco
workspace tests. One temporarily replaced the process-global VFS and another
installed its browser workspace VFS without ever restoring it, allowing
unrelated module-graph and inlay reads to hit the in-memory workspace. Project
loading now accepts an explicit VFS, its JSON cache is scoped per VFS instance,
and both Monaco test paths use the VFS already carried by their resolver
contexts instead of mutating global compiler state. This matters whenever
browser and Node compiler tests run concurrently, even though the failure
originally appeared next to the JSX work.

Follow-up full runs showed that shorter tests also temporarily deleted or
replaced the global VFS. Those mutations caused nondeterministic DOM navigation
and inlay failures depending on file scheduling. The remaining tests now use
explicit VFS/cache instances or directly exercise the unconfigured adapter, so
the official concurrent Node test runner no longer shares mutable filesystem
state between test files.
