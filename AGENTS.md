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
  - Binding-pattern traversal helpers: `compiler/ast/bindingPatterns.ts`
  - Shared structural AST traversal: `compiler/ast/traversal.ts`
- Source locations:
  - Shared user-facing source coordinate formatting: `compiler/sourceLocations.ts`
  - Source location tests: `compiler/sourceLocations.test.ts`
- Semantic analysis:
  - Public analysis API: `compiler/analysis/Analysis.ts`
  - Scope/symbol binding: `compiler/analysis/Binder.ts`
  - Type checking and semantic diagnostics: `compiler/analysis/TypeChecker.ts`
  - Shared structural type-text parsing/splitting and substitution helpers: `compiler/analysis/typeNames.ts`
  - Type-name helper tests: `compiler/analysis/typeNames.test.ts`
  - Project semantic index/cache: `compiler/analysis/projectIndex.ts`
  - Project index tests: `compiler/analysis/projectIndex.test.ts`
  - Analysis model/types: `compiler/analysis/model.ts`, `compiler/analysis/types.ts`
  - Analysis issue codes/contracts: `compiler/analysis/issueCodes.ts`
  - Analysis tests: `compiler/analysis/Analysis.test.ts`
- Embedded runtime declarations:
  - ECMAScript ambient declarations and cache: `compiler/runtime/ecmascript.d.my`, `compiler/runtime/ecmascriptDeclarations.ts`
- Emitter / transpilation:
  - Lowering pass boundary: `compiler/runtime/lowering.ts`
  - Lowering tests: `compiler/runtime/lowering.test.ts`
  - JavaScript emission: `compiler/runtime/emitter.ts`
  - Emission tests: `compiler/runtime/emitter.test.ts`
  - Transpile orchestration: `compiler/runtime/transpile.ts`
  - Runtime tooling helpers: `compiler/runtime/tooling.ts`
  - Transpile tests: `compiler/runtime/transpile.test.ts`
  - Runtime integration tests: `compiler/runtime/runtime.integration.test.ts`
- Formatter:
  - Formatter logic: `compiler/runtime/formatter.ts`
  - Formatter tests: `compiler/runtime/formatter.test.ts`
  - LSP formatting adapter: `compiler/lsp/formatting.ts`

### Tooling and Integration Pieces

- Compilation pipeline (separate shared parse and parse + analysis artifacts):
  - Parse phase: `compiler/pipeline/parse.ts`
  - Parse phase tests: `compiler/pipeline/parse.test.ts`
  - Compile phase: `compiler/pipeline/compile.ts`
  - Compile phase tests: `compiler/pipeline/compile.test.ts`
- CLI:
  - CLI entrypoint and commands: `compiler/cli.ts`
  - CLI tests: `compiler/cli.test.ts`
- LSP server and features:
  - Server entrypoint: `compiler/lsp/server.ts`
  - Project-level analysis adapter: `compiler/lsp/projectAnalysis.ts`
  - Session cache: `compiler/lsp/analysisSession.ts`
  - Completion: `compiler/lsp/completion.ts`
  - Diagnostics: `compiler/lsp/diagnostics.ts`
  - Cross-file type diagnostics: `compiler/lsp/crossFileTypeDiagnostics.ts`
  - Member diagnostics: `compiler/lsp/memberDiagnostics.ts`
  - Diagnostic code mapping: `compiler/lsp/diagnosticCodes.ts`
  - Navigation/rename/references: `compiler/lsp/navigation.ts`, `compiler/lsp/crossFileNavigation.ts`
  - Signature help: `compiler/lsp/signatureHelp.ts`
  - Document/workspace symbols: `compiler/lsp/symbols.ts`
  - Document structure/navigation services: `compiler/lsp/documentFeatures.ts`
  - Semantic tokens: `compiler/lsp/semanticTokens.ts`
  - Inlay hints: `compiler/lsp/inlayHints.ts`
  - Code action orchestration: `compiler/lsp/codeActions.ts`
  - Quick fixes: `compiler/lsp/importFixes.ts`, `compiler/lsp/typeFixes.ts`, `compiler/lsp/memberFixes.ts`, `compiler/lsp/callFixes.ts`, `compiler/lsp/keywordFixes.ts`, `compiler/lsp/interfaceImplementationFixes.ts`
  - Class/interface resolution helpers: `compiler/lsp/classResolver.ts`
  - LSP tests: `compiler/lsp/*.test.ts`
- VS Code extension and syntax highlighting:
  - Extension entrypoint: `plugins/vscode/extension.js`
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
- Architecture map consistency guard: `compiler/architectureMap.test.ts`

### Test Fixtures and Auxiliary Utilities

- Runtime sample fixture: `testFixtures/sample.my`
- Third-party declaration samples: `samples/PIXI.d.ts`, `samples/threejs.d.ts`
- TypeScript compatibility fixture: `testFixtures/typescript-supported.d.ts`
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
