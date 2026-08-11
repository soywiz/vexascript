# VS Code document highlights disappeared after the LSP response

## Symptom

Clicking a local identifier in VS Code briefly highlighted matching occurrences, but the backgrounds disappeared as soon as the VexaScript document-highlight response arrived. TypeScript identifiers remained visibly highlighted in the same editor.

The reported case was `samples/preact/html.vx`: the delegated `count` variable is declared in `App`, captured by `increment`, used as an object-shorthand property, and read in a dependency array.

## Investigation

The first hypothesis was that the semantic resolver returned no references for delegated variables, nested functions, or object shorthand. A focused `createDocumentHighlights` reproduction disproved that hypothesis: every occurrence returned the same four ranges.

The next hypothesis was that imported Preact declarations changed symbol identity in the real editor session. A full fake-VS-Code session using `AnalysisSessionCache`, project imports, ambient declarations, diagnostics, semantic tokens, and the actual `textDocument/documentHighlight` handler also returned the same four ranges at every probed occurrence. Its timing matched the roughly 0.1 ms request shown in the recording.

Frame-by-frame inspection showed the provisional selection backgrounds on all occurrences for a fraction of a second, followed by a completely unhighlighted background. A temporary VS Code extension then called `vscode.executeDocumentHighlights` against the installed VexaScript extension. VS Code itself returned all four ranges as `DocumentHighlightKind.Read`, while the effective editor settings were `Dark 2026`, `editor.occurrencesHighlight: "singleFile"`, and `editor.selectionHighlight: true`. This ruled out the VexaScript theme and the language-client transport as well.

The failure was the visual handoff from VS Code's provisional selection decoration to the regular, low-emphasis `Read` occurrence decoration. Returning the strong occurrence style keeps the semantic set visible across that handoff and does not depend on the user selecting the VexaScript color theme.

## Fix and regression coverage

`createDocumentHighlights` now returns the resolved semantic reference set with `DocumentHighlightKind.Write`, which VS Code renders with its strong occurrence background. This use is intentionally visual: every range still comes from the shared semantic reference resolver; the kind selects the persistent decoration style and does not change symbol resolution or edits.

The compiler-level test preserves the delegated/nested/object-shorthand reference case. The all-samples LSP harness can now probe document highlights, and the Preact sample asserts that the real server path returns all four ranges. Keep both levels: a visual regression can resemble a resolver failure even when the protocol result is already correct.
