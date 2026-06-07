# AGENTS

## Project context

MyLang is a language derived from TypeScript with some features and ideas from Swift, Kotlin, C# and other languages.

## Commands

- Run tests once: `pnpm test`
- Run tests with coverage: `pnpm coverage`
- Run vscode with the plugin+lsp: `pnpm code`
- Run monaco sample: `pnpm monaco`

## File Structure & Maintenance Rule

- In docs/file.structure.md there is a explanation of the file structure of the repository. Keep it updated.
- If a new architectural piece/module is added (new compiler phase, new service, new plugin integration, new docs surface, etc.), this Architecture Map in `docs/file.structure.md` and `AGENTS.md` must be updated in the same change so future agents can understand the repository quickly.

## Testing policy

- We follow TDD (Test-Driven Development).
- Every new feature must include tests in the same change.
- The official test suite runs with node tests.
- Minimum acceptance criterion: a feature is not considered complete without automated tests validating its behavior.
- Before closing any task, the full test suite must pass.
- For UI-facing changes (Monaco plugin, browser flows, visual interactions), validate the final behavior in a real browser before handing off. Use Playwright or another browser automation path when available, and treat that browser check as part of completion rather than an optional extra.
- If tests fail, they must be fixed before finishing the task.
- If requirements change, update tests to match the new expected behavior instead of preserving outdated assertions.

## Language policy

- Everything, including all code, documentation, messages, issue descriptions, etc. must be written in English.

## Documentation policy

- Supported language syntax documentation lives in `docs/syntax.md`. Every time new language syntax support is added it must be updated in the same change.
