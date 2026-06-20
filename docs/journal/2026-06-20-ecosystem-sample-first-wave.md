# Ecosystem Sample First Wave

## What landed

This round expanded the sample suite with two focused browser samples instead of
only relying on the larger mixed `samples/react/` app:

- `samples/react-query/`
- `samples/react-router/`

The goal was to make it easier to debug React ecosystem regressions in
isolation, without having router, query, and broader UI logic failures blended
together in one sample.

## Why these two were the right first landing

The active task list already called out both libraries as first-wave
stress-sample candidates, and the repository already had evidence that their
basic interop path was close to working because `samples/react/` used them
successfully.

Splitting them into focused samples added better regression leverage with low
risk:

- router breakages can now be reproduced in a tiny MemoryRouter-only sample
- React Query typing or LSP issues can now be reproduced in a tiny query-only
  sample
- the broader React sample can stay more product-like without becoming the only
  place that covers those libraries

## Compiler work that helped

While probing additional candidate libraries, a smaller but real compiler gap
showed up in imported node-module typing resolution:

- named imports reexported from local namespace bindings inside package `.d.ts`
  files were not being resolved correctly

The minimal regression shape was:

- a package file using `import * as z from "./external"; export { z };`

That exposed two missing behaviors:

- the selective node-module typing collector needed to treat local
  `export { ... }` specifiers as directly relevant exports
- the named-import resolver needed to understand `ExportStatement` wrappers
  whose underlying declaration was an `ImportStatement`

Targeted node-module typing coverage was added for that pattern.

## What did not land yet

Three additional first-wave libraries were explored but not kept as checked-in
samples yet:

- `zod`
- `rxjs`
- `hono`

They were all valuable probes, but each surfaced deeper work than was worth
landing as a half-working sample:

- `zod` still wants better namespace-style exported local binding support all
  the way through schema-builder member resolution
- `rxjs` still wants richer imported generic/variadic typing for Observable
  creation and operator-heavy chains
- `hono` still wants better imported handler/context typing plus cleaner
  interaction with overlapping DOM/runtime declarations

The important lesson is to keep probe samples during investigation only long
enough to classify the failure, then either finish them completely or remove
them and record the blocker explicitly.

## Regression guidance

- Prefer focused ecosystem samples over only one large integration sample when a
  library family is already known to be important.
- When package exports rely on local namespace bindings or reexported imported
  names, add the minimal `.d.ts` regression before changing real samples.
- Do not keep half-working stress samples checked in just because they exposed a
  useful failure mode; convert the insight into a task or journal note first.
