# TypeScript Compiler Self-Hosting

## Context

The full `cli/cli-bin.ts` graph was used as the self-hosting target rather than
a reduced parser-only entrypoint. This exercises the parser, semantic metadata,
JavaScript emitter, local module graph, package bundler, Node externals, and the
generated CLI runtime together.

## Failures Found

The first checked build was blocked by false-positive VexaScript semantic
diagnostics over valid TypeScript and Node declaration shapes. Making the
compiler progressively accept every advanced TypeScript type would conflate
JavaScript emission with VexaScript's own type-system coverage. The durable
boundary is an explicit transpile-only mode: parsing and analysis still run,
while TypeScript's own `tsc` check remains authoritative.

The first emitted compiler then contained an invalid concise arrow body. An
object literal wrapped by `as const` was no longer recognized as requiring
parentheses after type erasure. The fix detects object literals through
type-only wrappers in the shared emitter.

The next execution exposed two module-resolution assumptions:

- the nearest `tsconfig.json` was already loaded but its `baseUrl` was discarded,
  causing `compiler/...` source imports to become runtime externals;
- a dotted basename such as `ecmascriptDeclarations.shared` was mistaken for a
  file with a final extension, so `.shared.ts` was never attempted.

Both issues were fixed in shared resolution paths and covered by focused tests.

## Dead Ends And Evidence

Running a browser bundle under Node failed on `node:child_process`. This was not
a missing compiler feature: browser bundles deliberately reject unresolved
externals. Adding an explicit Node bundle platform reused the existing
`createRequire` external strategy without weakening browser output.

Executing the generated CLI from the repository root initially looked healthy,
but `cli-bin.ts` delegates to the source CLI when it finds `cli/cli.ts` and
`tsx`. That would make later passes false positives. All generated compilers are
therefore executed from the isolated output directory.

## Result

Three generations of the complete compiler now converge to the same SHA-256
and identical bytes. The final generation also bundles and runs the normal CLI
fixture. `pnpm self-host` exposes the workflow and `cli/selfHost.test.ts` keeps
it in the normal test suite.
