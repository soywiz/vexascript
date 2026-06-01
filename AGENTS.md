# AGENTS

## Project context

- MyLang is a language derived from TypeScript.

## Architecture Map

This section is the fast onboarding map for agents and contributors.

### Core Pieces

- Parser:
  - Main parser implementation: `compiler/parser/parser.ts`
  - Parser tests: `compiler/parser/parser.test.ts`
- Tokenizer:
  - Tokenization and lexical errors: `compiler/parser/tokenizer.ts`
  - Tokenizer tests: `compiler/parser/tokenizer.test.ts`
- AST:
  - AST node definitions: `compiler/ast/ast.ts`
- Source locations:
  - Shared user-facing source coordinate formatting: `compiler/sourceLocations.ts`
  - Source location tests: `compiler/sourceLocations.test.ts`
- Semantic analysis:
  - Public analysis API: `compiler/analysis/Analysis.ts`
  - Scope/symbol binding: `compiler/analysis/Binder.ts`
  - Type checking and semantic diagnostics: `compiler/analysis/TypeChecker.ts`
  - Generic type-name parsing/substitution helpers: `compiler/analysis/typeNames.ts`
  - Project semantic index/cache: `compiler/analysis/projectIndex.ts`
  - Analysis model/types: `compiler/analysis/model.ts`, `compiler/analysis/types.ts`
  - Analysis issue codes/contracts: `compiler/analysis/issueCodes.ts`
  - Analysis tests: `compiler/analysis/Analysis.test.ts`
- Emitter / transpilation:
  - Lowering pass boundary: `compiler/runtime/lowering.ts`
  - JavaScript emission: `compiler/runtime/emitter.ts`
  - Emission tests: `compiler/runtime/emitter.test.ts`
  - Transpile orchestration: `compiler/runtime/transpile.ts`
  - Transpile tests: `compiler/runtime/transpile.test.ts`
- Formatter:
  - Formatter logic: `compiler/runtime/formatter.ts`
  - Formatter tests: `compiler/runtime/formatter.test.ts`
  - LSP formatting adapter: `compiler/lsp/formatting.ts`

### Tooling and Integration Pieces

- Compilation pipeline (shared parse + analysis artifacts):
  - `compiler/pipeline/compile.ts`
  - Tests: `compiler/pipeline/compile.test.ts`
- CLI:
  - CLI entrypoint and commands: `compiler/cli.ts`
  - CLI tests: `compiler/cli.test.ts`
- LSP server and features:
  - Server entrypoint: `compiler/lsp/server.ts`
  - Completion: `compiler/lsp/completion.ts`
  - Diagnostics: `compiler/lsp/diagnostics.ts`
  - Navigation/rename/references: `compiler/lsp/navigation.ts`, `compiler/lsp/crossFileNavigation.ts`
  - Signature help: `compiler/lsp/signatureHelp.ts`
  - Document/workspace symbols: `compiler/lsp/symbols.ts`
  - Auto-import fixes: `compiler/lsp/importFixes.ts`
  - Session cache: `compiler/lsp/analysisSession.ts`
  - LSP tests: `compiler/lsp/*.test.ts`
- VS Code syntax highlighting:
  - TextMate grammar: `plugins/vscode/syntaxes/mylang.tmLanguage.json`
  - VS Code extension manifest/config: `plugins/vscode/package.json`, `plugins/vscode/language-configuration.json`
  - Syntax tests: `compiler/vscodeext-syntax.test.ts`

### Docs and Specs

- Supported syntax: `docs/syntax.md`
- Pending syntax roadmap: `docs/syntax.pending.md`
- Pending technical tasks/backlog: `docs/tasks.pending.md`
- LSP services status: `docs/lsp.services.md`
- Semantic analysis spec: `docs/semantic.spec.md`
- Transpilation design note: `docs/transpilation.design.md`

### Test Fixtures and Auxiliary Utilities

- Runtime sample fixture: `testFixtures/sample.my`
- Fixture tests: `testFixtures/@test.test.ts`
- Reader utilities used by parser/tokenizer:
  - `compiler/utils/ListReader.ts`, tests: `compiler/utils/ListReader.test.ts`
  - `compiler/utils/StrReader.ts`, tests: `compiler/utils/StrReader.test.ts`

### Maintenance Rule

- If a new architectural piece/module is added (new compiler phase, new service, new plugin integration, new docs surface, etc.), this Architecture Map in `AGENTS.md` must be updated in the same change so future agents can understand the repository quickly.

## Testing policy

- We follow TDD (Test-Driven Development).
- Every new feature must include tests in the same change.
- The official test suite runs with Vitest.
- Minimum acceptance criterion: a feature is not considered complete without automated tests validating its behavior.
- Before closing any task, the full test suite must pass.
- If tests fail, they must be fixed before finishing the task.
- Skipping tests is allowed only as a last resort in exceptional cases; overusing skips weakens the suite and is not acceptable.
- If requirements change, update tests to match the new expected behavior instead of preserving outdated assertions.

## Language policy

- All code and documentation must be written in English.

## Documentation policy

- Supported language syntax documentation lives in `docs/syntax.md`.
- Pending TypeScript syntax roadmap lives in `docs/syntax.pending.md`.
- Technical backlog and pending implementation tasks live in `docs/tasks.pending.md`.
- Every time new language syntax support is added, `docs/syntax.md` must be updated in the same change.
- Every time a pending syntax item is implemented, `docs/syntax.pending.md` must be updated in the same change (remove or mark the implemented item).
- Every time new missing syntax is identified, `docs/syntax.pending.md` must be updated in the same change.
- Every time a significant architectural or tooling gap is identified, `docs/tasks.pending.md` must be updated in the same change.

## Commands

- Run tests once: `pnpm test`
- Run tests in watch mode: `pnpm test:watch`
