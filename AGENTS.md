# AGENTS

## Project context

MyLang is a language derived from TypeScript with some features and ideas from Swift, Kotlin, C# and other languages.

- Monaco sample theme configuration, including editor token colors for MyLang-specific comment styling, lives in `plugins/monaco/src/theme.ts`.
- Shared LSP declaration-documentation extraction for `///` and block doc comments lives in `compiler/lsp/documentation.ts`.
- Instance-member `this.` add/remove quick fixes live in `compiler/lsp/thisFixes.ts`.

## Important

- Do not use synchronous I/O API calls. Only use asynchronous I/O APIs. The compiler is intended to run both in node and the browser.

## Commands

- Run tests once: `pnpm test`
- Keep the `test` script as `tsc --noEmit && node --import tsx --test --test-reporter spec`. Do not add explicit test-file globs or `rg`/`find` enumeration to it unless the current autodiscovery behavior actually breaks. In this repository, Node's test runner with `--import tsx` already discovers and runs the `.test.ts` suite correctly.
- Run tests with coverage: `pnpm coverage`
- Run vscode with the plugin+lsp: `pnpm code`
- Run monaco sample: `pnpm monaco`
- Print embedded editor syntax bundles: `pnpm tsx compiler/cli.ts syntax --monaco|--vscode-grammar|--vscode-configuration|--codemirror`

## File Structure & Maintenance Rule

- In docs/file.structure.md there is a explanation of the file structure of the repository. Keep it updated.
- If a new architectural piece/module is added (new compiler phase, new service, new plugin integration, new docs surface, etc.), this Architecture Map in `docs/file.structure.md` must be updated in the same change so future agents can understand the repository quickly.
- The Monaco sample shell lives in `plugins/monaco/src/main.ts`, its browser-only virtual workspace lives in `plugins/monaco/src/workspace.ts`, and cross-tab navigation history helpers live in `plugins/monaco/src/navigationHistory.ts`.
- Shared async file helpers live in `compiler/utils/fs.ts`, and shared async process helpers live in `compiler/utils/io.ts`. Reuse them instead of duplicating `fileExists`, directory probes, or child-process wrappers.
- Repository samples live under `samples/<name>/`. The sample test harness runs directories that contain expected.txt, installs package.json dependencies with pnpm install when node_modules is absent, and lets each sample provide its own tsconfig.json for compiler options such as JSX factories or DOM libraries.

## Testing policy

- We follow TDD (Test-Driven Development).
- Every new feature must include tests in the same change.
- The official test suite runs with node tests.
- Minimum acceptance criterion: a feature is not considered complete without automated tests validating its behavior.
- Before closing any task, the full test suite must pass.
- In LSP/editor tests, prefer the `^^^` cursor-marker style with the shared helper in `compiler/test/sourceWithCursor.ts` instead of hardcoded line/column coordinates whenever practical.
- For UI-facing changes (Monaco plugin, browser flows, visual interactions), validate the final behavior in a real browser before handing off. Use Playwright or another browser automation path when available, and treat that browser check as part of completion rather than an optional extra.
- If tests fail, they must be fixed before finishing the task.
- If requirements change, update tests to match the new expected behavior instead of preserving outdated assertions.
- For editor/LSP cursor-position tests, prefer the shared `^^^` marker helper in `compiler/test/sourceWithCursor.ts` over hardcoded line/column pairs.

## Language policy

- Everything, including all code, documentation, messages, issue descriptions, etc. must be written in English.

## Documentation policy

- Supported language syntax documentation lives in `docs/syntax.md`. Every time new language syntax support is added it must be updated in the same change.
