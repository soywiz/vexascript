# Node-module auto-import discovery without existing imports

## Symptom

In `samples/threejs/extensions.vx`, typing `Vector` did not offer `Vector3`
from `three` when the file had no import statements. Adding any import made
the Three.js auto-import candidates appear. Workspace and DOM completions were
otherwise available, so the visible failure looked like editor ranking or a
stale extension at first.

## Root cause

The shared auto-import builder collected workspace exports and node-module
exports, but the node-module branch obtained package specifiers exclusively
from import statements already present in the current AST. An import-free file
therefore supplied an empty package set even though its nearest `package.json`
declared `three` as a dependency. Adding an unrelated import changed discovery
state and accidentally unlocked the package catalog.

A small fixture with a direct `export class Vector3` reproduced the dependency
discovery gap. The real Three.js sample then exposed an additional edge: its
manifest declares both `@types/three` and `three`. Scanning every dependency
without filtering produced two candidates, including the invalid runtime
import `from "@types/three"`. The declaration-barrel traversal itself was not
the problem; `getNodeModuleTypings` already reached the real `Vector3`
declaration through the Three.js re-export graph.

## Fix

Node-module auto-import discovery now unions bare module specifiers already in
the AST with runtime dependencies from the nearest project manifest. Packages
under `@types/` are excluded from manifest-driven suggestions because they
provide declarations for another module and are not valid runtime import
targets. Explicit imports continue to be honored, and the same shared
collector feeds both completion items and undefined-symbol quick fixes.

The regression follows the public completion path with an import-free
extension function that references `Vector3`, a project manifest containing
both `@types/three` and `three`, and installed package declarations. It asserts
that exactly one `Vector3` suggestion is returned and that accepting it inserts
`import { Vector3 } from "three"`.

## Validation

The focused completion suite passes. A direct probe against the real
`samples/threejs` package graph, after removing the existing import from the
in-memory source, returns exactly one `Vector3` auto-import candidate from
`three`.
