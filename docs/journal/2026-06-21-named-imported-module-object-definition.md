# Named-Imported Module Object Definition

## What failed

`samples/zod/main.vx` reached a state where typing and diagnostics were correct,
but go-to-definition still failed on `z.object`.

The visible symptom in VS Code was:

- `No definition found for 'object'`

That was a good reminder that imported-type correctness and navigation
correctness are related but not identical. Hover and type analysis already knew
enough about `z`, but the member-definition path used different plumbing.

## Root cause

There turned out to be two separate issues in the navigation path.

The first one was that the helper that recognizes module-object receivers only
treated these forms as module objects:

- default imports
- namespace imports

It did **not** treat a named import binding as a potential module-like receiver.

That broke cases like:

```vx
import { z } from "zod"
z.object(...)
```

Even though `z` is effectively a namespace-shaped export from the package, the
definition path never considered its import as a module receiver, so it never
asked node_modules export-resolution to locate `object`.

After fixing that, the real `samples/zod` workspace still failed. The second
issue was deeper in node_modules export lookup:

- `zod` exposes `object` through `export { objectType as object }`
- `findNodeModuleExportLocation(...)` only understood direct exported
  declarations such as `export function foo()` or `export interface Foo {}`
- it did not resolve aliased export specifiers back to the local declaration

So the parser could identify `z.object`, and the receiver import was now
accepted, but export resolution still returned `null` for `object`.

## What helped

The successful fix stayed small, but it needed both layers:

- extend `findModuleReceiverImport(...)` to also match named import bindings via
  `(specifier.local ?? specifier.imported).name`
- teach `findNodeModuleExportLocation(...)` to handle
  `export { localName as exportedName }`
- when that export specifier is local, resolve it back to the matching
  top-level declaration or import binding in the same `.d.ts` file instead of
  stopping on the export line
- add a focused node_modules export test for the aliased export-specifier case
- harden the cross-file navigation regression so it uses
  `objectType as object`, which matches the real Zod shape more closely

That restored the node_modules export-navigation path without changing the type
checker or broader member resolution.

## What did not need changing

- imported type collection
- Zod-specific type synthesis
- generic member-definition logic for ordinary class/interface receivers

This ended up being two navigation bugs: receiver eligibility first, then
aliased export-specifier resolution.

## Final outcome

Go-to-definition now works for named-imported module-object style bindings such
as `z.object`, and the full suite still passes.

## Regression guidance

- When a package exposes a namespace-shaped object through a named export, treat
  the local binding as a valid module receiver for navigation.
- When a package reexports API members through `export { local as publicName }`,
  definition lookup must follow that alias back to the local declaration.
- If hover/types work but definition fails, compare the import-shape detection
  used by navigation against the richer paths already used by type analysis.
- If a first fix only makes synthetic tests pass, reproduce against the real
  workspace before trusting the diagnosis.
