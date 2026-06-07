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
- Module resolution:
  - Shared local import-path resolution (`import ... from "<path>"` to an absolute `.my` file), used by the semantic project index and the LSP cross-file features: `compiler/moduleResolution.ts`
  - Module resolution tests: `compiler/moduleResolution.test.ts`
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
  - Current ambient runtime declarations consumed by the compiler from bundled TypeScript declarations: `compiler/runtime/es2025.d.ts`, `compiler/runtime/ecmascriptDeclarations.ts`
  - Bundled TypeScript DOM declarations for future TypeScript declaration-file runtime consumption: `compiler/runtime/dom.d.ts`
- Emitter / transpilation:
  - Lowering pass boundary: `compiler/runtime/lowering.ts`
  - Lowering tests: `compiler/runtime/lowering.test.ts`
  - JavaScript emission: `compiler/runtime/emitter.ts`
  - Emission tests: `compiler/runtime/emitter.test.ts`
  - Transpile orchestration: `compiler/runtime/transpile.ts`
  - Local module-graph bundling for execution (resolves and inlines a `.my` entry file together with its transitively imported local modules so cross-file classes/operators/extension properties resolve at run time): `compiler/runtime/moduleGraph.ts`
  - Module-graph bundling tests: `compiler/runtime/moduleGraph.test.ts`
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
- Monaco browser plugin (project root: `plugins/monaco/`):
  - Static Monaco demo entrypoint: `plugins/monaco/src/main.ts`
  - Monaco-to-compiler provider adapter (in-process; does NOT use LSP, calls the
    compiler's `compiler/lsp/*` feature functions directly and maps them to
    Monaco's `monaco.languages.register*Provider` APIs to reach VS Code feature
    parity): `plugins/monaco/src/compiler-providers.ts`
  - Optional LSP-over-Web-Worker path (alternative transport, not wired into the
    default demo): `plugins/monaco/src/lsp-providers.ts`,
    `plugins/monaco/src/compiler-client.ts`, `plugins/monaco/src/lsp-worker.ts`,
    `plugins/monaco/src/lsp-client.ts`, `compiler/lsp/server-browser.ts`
  - Browser stubs for Node built-ins used by shared compiler modules:
    `plugins/monaco/src/browser-stubs/`
  - Static workspace persistence helpers: `plugins/monaco/src/workspace.ts`
  - Demo backend server: `plugins/monaco/server.mjs`
  - Monaco package manifest and Vite config: `plugins/monaco/package.json`, `plugins/monaco/vite.config.ts`
- LSP server and features:
  - Server entrypoint: `compiler/lsp/server.ts`
  - Project-level analysis adapter: `compiler/lsp/projectAnalysis.ts`
  - Session cache: `compiler/lsp/analysisSession.ts`
  - Completion: `compiler/lsp/completion.ts`
  - Diagnostics: `compiler/lsp/diagnostics.ts`
  - Cross-file type diagnostics: `compiler/lsp/crossFileTypeDiagnostics.ts`
  - Member diagnostics: `compiler/lsp/memberDiagnostics.ts`
  - Diagnostic code mapping: `compiler/lsp/diagnosticCodes.ts`
  - Shared position/range helpers for LSP quick fixes and document features: `compiler/lsp/ranges.ts`
  - Shared AST node search helpers for LSP quick-fix target lookup: `compiler/lsp/nodeSearch.ts`
  - Navigation/rename/references: `compiler/lsp/navigation.ts`, `compiler/lsp/crossFileNavigation.ts`
  - Signature help: `compiler/lsp/signatureHelp.ts`
  - Document/workspace symbols: `compiler/lsp/symbols.ts`
  - Document structure/navigation services: `compiler/lsp/documentFeatures.ts`
  - Semantic tokens: `compiler/lsp/semanticTokens.ts`
  - Inlay hints: `compiler/lsp/inlayHints.ts`
  - Await gutter decorations (lines with an explicit `await` in async/sync functions or an implicit auto-`await` inside `sync` functions, served via the custom `mylang/autoAwaitDecorations` request and the Monaco glyph margin): `compiler/lsp/autoAwaitDecorations.ts`
  - Code action orchestration: `compiler/lsp/codeActions.ts`
  - Shared code-action collection (used by both the LSP server and the Monaco in-process providers): `compiler/lsp/codeActionsAggregate.ts`
  - Quick fixes: `compiler/lsp/importFixes.ts`, `compiler/lsp/typeFixes.ts`, `compiler/lsp/memberFixes.ts`, `compiler/lsp/callFixes.ts`, `compiler/lsp/keywordFixes.ts`, `compiler/lsp/interfaceImplementationFixes.ts`, `compiler/lsp/stringTemplateFixes.ts`
  - Function shorthand quick fixes: `compiler/lsp/functionShorthandFixes.ts`
  - Trailing-lambda quick fix (moves a brace lambda written as the last call argument out of the parentheses, e.g. `foo(a, { x -> ... })` to `foo(a) { x -> ... }`): `compiler/lsp/trailingLambdaFixes.ts`
  - Explicit return type quick fix (adds an inferred return type annotation after the parameter list of a function/method declaration that has no explicit return type, e.g. `function add(a, b) { ... }` to `function add(a, b): number { ... }`): `compiler/lsp/returnTypeFixes.ts`
  - Empty class body quick fix (removes the empty braces from a class that declares no members, e.g. `class TimeSpan(val ms: number) { }` to `class TimeSpan(val ms: number)`): `compiler/lsp/emptyClassBodyFixes.ts`
  - Shared cross-file top-level declaration resolution helpers: `compiler/lsp/declarationResolver.ts`
  - Class/interface resolution helpers: `compiler/lsp/classResolver.ts`
  - Imported type-declaration collection feeding cross-file extension-method/`this` resolution into the per-document analysis (via `Analysis` `externalDeclarations`): `compiler/lsp/importedDeclarations.ts`
  - LSP tests: `compiler/lsp/*.test.ts`
- VS Code extension and syntax highlighting (project root: `plugins/vscode/`):
  - Extension entrypoint (LSP client that launches `compiler/lsp/server.ts` over stdio): `plugins/vscode/extension.js`
  - TextMate grammar: `plugins/vscode/syntaxes/mylang.tmLanguage.json`
  - VS Code extension manifest/config: `plugins/vscode/package.json`, `plugins/vscode/language-configuration.json`
  - Syntax tests: `compiler/vscodeext-syntax.test.ts`

### Docs and Specs

- Supported syntax: `docs/syntax.md`
- Pending technical tasks/backlog: `docs/tasks.pending.md`
- LSP services status: `docs/lsp.services.md`
- Semantic analysis spec: `docs/semantic.spec.md`
- Transpilation design note: `docs/transpilation.design.md`
- Architecture map consistency guard: `compiler/architectureMap.test.ts`

### Test Fixtures and Auxiliary Utilities

- Runtime sample fixture: `testFixtures/sample.my`
- Third-party declaration samples: `testFixtures/PIXI.d.ts`, `testFixtures/threejs.d.ts`
- TypeScript compatibility fixture: `testFixtures/typescript-supported.d.ts`
- Fixture tests: `testFixtures/@test.test.ts`
- Reader utilities used by parser/tokenizer:
  - `compiler/utils/ListReader.ts`, tests: `compiler/utils/ListReader.test.ts`
  - `compiler/utils/StrReader.ts`, tests: `compiler/utils/StrReader.test.ts`
