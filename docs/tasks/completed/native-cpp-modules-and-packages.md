# Complete Native Module And Package Support

## Status

* [x] Completed

## Context

Native module compilation currently merges dependency-ordered local modules into
one translation unit. Named imports without aliases and side-effect imports work,
but default, namespace, and aliased imports are rejected. Native compilation is
also limited to file entrypoints and does not yet provide a practical contract
for package dependencies or project-directory builds.

## Goal

Give native builds stable module identity, complete local import/export behavior,
and an explicit package interoperability model.

## Scope

* [x] Preserve module-local symbol namespaces instead of relying on one merged
  global namespace.
* [x] Support aliased named imports and exports.
* [x] Support default imports and exports.
* [x] Support namespace imports and qualified member access.
* [x] Preserve deterministic top-level initialization order and diagnose cycles
  whose initialization semantics cannot be represented safely.
* [x] Support native project-directory entrypoint and `outDir` workflows.
* [x] Define which package sources can compile natively and how native bindings
  are declared for packages that only ship JavaScript binaries.
* [x] Reuse shared project configuration, import resolution, and package metadata
  rather than creating a native-only resolver.
* [x] Produce clear diagnostics for JavaScript-only dependencies without a native
  implementation or compilable VexaScript/TypeScript source.

## Acceptance Criteria

* [x] Two modules may declare the same private symbol without collisions.
* [x] Named, aliased, default, namespace, and side-effect imports execute with the
  same observable initialization order as the supported JavaScript path.
* [x] A configured project directory can produce a native executable.
* [x] Package interoperability has a documented, testable contract.

## Tests

* [x] Add module-graph tests for every import/export form and name collision.
* [x] Add native compile-and-run tests for multi-module initialization.
* [x] Add at least one package or native-binding fixture.
* [x] Run `pnpm test`.
* [x] Run `pnpm cli vexa testFixtures/sample.vx`.

## Completion Summary

Native module graphs isolate symbols, preserve dependency initialization order,
support every local import/export form, reuse project import mappings, and emit
per-module source locations. Packages compile from mapped VexaScript/TypeScript
source; JavaScript-only packages receive a targeted diagnostic. A packed release
is also compiled and executed from an external temporary consumer.

## Related Files

* `compiler/moduleResolution.ts`
* `compiler/project.ts`
* `compiler/importedSymbols.ts`
* `compiler/runtime/nativeModuleGraph.ts`
* `compiler/runtime/cppEmitter.ts`
* `cli/cli.ts`
* `cli/nativeBuild.ts`
