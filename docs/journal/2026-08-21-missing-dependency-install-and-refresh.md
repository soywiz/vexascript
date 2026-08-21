# Missing dependency installation and editor refresh

## Symptom

VS Code reported `Cannot find module 'three'` for an import whose package was
already declared in the nearest `package.json`, but the diagnostic exposed no
quick fix. Installing the dependency from another terminal did not reliably
remove the error after returning to the editor because the open document and
its imports had not changed.

## Root cause

The LSP already had a complete invalidation path for watched VexaScript files:
it cleared document diagnostics, code actions, analysis sessions, declaration
typings, ambient types, and module-resolution caches. Two entrypoints bypassed
that path:

- the workspace refresh command only requested new diagnostics without
  invalidating any cached import resolution;
- the VS Code client watched only `*.vx`, so an external install did not produce
  a relevant watched-file event, and returning focus to the editor did nothing.

The missing-module diagnostic also had no code-action producer that connected
the imported package name to a declaring project manifest and a Node-only
installation command.

## Fix

The shared code-action aggregate now includes a missing-dependency producer for
the Node workspace environment. It matches the structured
`IMPORT_MODULE_NOT_FOUND` diagnostic to the corresponding import statement,
normalizes package subpaths to their package name, walks ancestor manifests,
and offers `Run 'npm install'` only when the package is declared in
`dependencies`, `devDependencies`, `optionalDependencies`, or
`peerDependencies`.

The command target carries the manifest directory and package name. The
Node-only LSP adapter revalidates that the target is inside a workspace root and
that the dependency is still declared before spawning `npm install`. Process
output is captured rather than inherited because stdout is the LSP protocol
transport.

The server now routes manual refreshes, completed installations, and watched
file changes through one invalidation function. The VS Code client watches
package manifests and lockfiles and sends the refresh command whenever the
window regains focus, covering installs performed in an external terminal even
when no source document version changes.

## Investigation notes

The first hypothesis was that only the document-diagnostic map retained the
error. The full LSP reproduction showed that clearing that map alone would not
be sufficient: `AnalysisSessionCache` keys external declarations by the import
text, and the node-module typings path cache also stores negative resolutions.
Both survive an unchanged document version, so the durable fix had to reuse the
existing whole-workspace invalidation path.

An initial implementation imported the CLI process helper into the Node LSP
entrypoint. The repository layering test correctly rejected that dependency
because all `compiler/` sources must stay independent of sibling application
folders. The final adapter uses `process.getBuiltinModule` in the explicitly
Node-only server entrypoint, matching the existing filesystem host pattern and
keeping shared compiler and browser code free of Node imports.

## Validation

The regression follows the real server-core route: it opens a document, obtains
the missing-module diagnostic and install code action, creates package typings
without changing the document, executes the same refresh command sent on focus,
and verifies that the diagnostic disappears. A separate VS Code client test
verifies the focus transition request. The focused LSP, extension packaging,
and layering suites pass, as do the full 2,898-test suite, the CLI smoke check,
and the TypeScript/JavaScript/native self-hosting fixed point.

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: OpenAI

## Prompts

1.

   ```text
   Mira el screenshot. Añade un quickfix para que si hay un import que no existe pero que está en el package.json, se haga un npm install

   también haz que si hago un npm install desde fuera y vuelvo al editor, los imports que daban error se refresquen y no se quede cacheado el error de que no existen
   ```
