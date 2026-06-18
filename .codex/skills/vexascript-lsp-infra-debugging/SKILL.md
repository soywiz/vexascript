---
name: vexascript-lsp-infra-debugging
description: Debug VexaScript problems where the visible symptom is in VS Code, Monaco, LSP hover/go-to-definition/diagnostics/semantic tokens, bundled sample runtime output, or generated JavaScript, especially when the fix requires reproducing the full compiler/LSP/import/session infrastructure instead of only inspecting one source file.
---

# VexaScript LSP Infrastructure Debugging

Use this skill when an editor symptom does not match compiler/runtime behavior, or when a feature works in simple tests but fails in VS Code, Monaco, samples, node_modules declarations, generated bundles, or cross-file imports.

## Core Rule

Reproduce the exact infrastructure path before changing the implementation:

1. Identify the user-visible surface: diagnostics, hover, go-to-definition, semantic tokens, formatting, emitted JavaScript, sample serve output, or browser runtime.
2. Find the LSP/compiler entrypoint for that surface.
3. Build a focused in-process reproduction that calls the same entrypoint with realistic sessions, imports, source roots, and `getSessionForFilePath`.
4. Add a regression test that uses the same path.
5. Only then patch the shared resolver/type/emitter/parser code.
6. Validate with focused tests, full tests, the CLI smoke check, and extension/browser installation when relevant.

## Infrastructure Checklist

For cross-file LSP behavior, do not create a bare `createAnalysisSession(source)` and assume that matches VS Code. VS Code usually has imported declarations and external symbol metadata.

Use this shape:

```ts
const baseSession = createAnalysisSession(source);
const collected = await collectAllImportedDeclarations(baseSession.ast!, {
  uri,
  sourceRoots,
  getSessionForFilePath
});
const session = createAnalysisSession(
  source,
  collected.externalDeclarations,
  collected.importedSymbolTypes,
  [],
  new Map(),
  new Map(),
  collected.importedSymbolDisplayTypes,
  collected.invalidImportedBindings
);
```

Then call the same public resolver the LSP uses, such as:

- `resolveDefinitionAcrossFiles` or `resolveDefinitionWithLocalFallback`
- `resolveHoverWithLocalFallback`
- type diagnostics collection
- semantic-token generation
- completion/signature/inlay helpers

For cursor-sensitive bugs, test multiple positions: inside the token, at token end, and where VS Code actually sends the request. Prefer `sourceWithCursor` for tests, but use explicit line/character probing when reproducing editor token-end behavior.

## Common Failure Pattern

If hover works but go-to-definition fails, avoid assuming type analysis is broken. It often means:

- hover used a type-checker path that already resolved the symbol,
- definition uses a separate navigation path,
- navigation is missing imported declarations, extension members, inherited members, merged declarations, generic defaults, node_modules declarations, or candidate cursor positions.

Debug by comparing:

1. Does `TypeChecker.getExpressionType(...)` know the member?
2. Does the navigation helper find the AST node at the VS Code cursor position?
3. Does cross-file declaration resolution search the same imported declarations that the type checker sees?
4. Does the resolver return a `Location` with the original declaration file/range, not the import line?

## Samples And Runtime

When the visible issue involves `samples/<name>` or `pnpm cli serve`, inspect the generated output too. For bundled samples, confirm both:

- the compiler/LSP diagnostics are clean,
- the emitted `__vexa_bundle__.js` calls the correct lowered runtime form.

For extension members, verify generated code uses the mangled standalone function/property accessor when appropriate, not native member access:

```js
View$$addTo$$Container$any(receiver, stage)
View$$point$set(receiver, value)
```

If the browser still shows an old error after a compiler fix, rebuild/reinstall the extension or restart the dev server before trusting the UI.

## Validation Sequence

Use the narrowest relevant tests first:

```bash
pnpm test -- compiler/lsp/crossFileNavigation.test.ts compiler/lsp/crossFileTypeDiagnostics.test.ts samples/pixi.test.ts
```

Then run the required project checks before finishing:

```bash
pnpm test
pnpm cli vexa testFixtures/sample.vx
```

For VS Code extension behavior, package/install the extension after tests pass:

```bash
pnpm vscodeext:install
```

Tell the user to reload VS Code or restart the extension host if the editor still shows cached behavior.

## Editing Guidance

Prefer unified resolver paths. If one subsystem already knows how to resolve a symbol, avoid adding a parallel special-case branch unless the existing abstraction cannot represent the case.

Keep fixes near the shared layer:

- parser/tokenizer/AST for syntax shape,
- type checker for semantic knowledge,
- emitter for runtime lowering,
- declaration/import resolvers for cross-file symbol discovery,
- LSP surface helpers only for request-specific cursor/range adaptation.

Do not treat VS Code screenshots as proof of the current source state after a code change. Confirm with an in-process reproduction and reinstall/reload the editor integration.
