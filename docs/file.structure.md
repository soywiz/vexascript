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
- Module resolution and virtual file access:
  - Shared asynchronous virtual file-system interface used across compiler, LSP, runtime bundling, and browser adapters: `compiler/vfs.ts`
  - Node-only local disk implementation of that VFS contract for CLI/LSP/test flows: `compiler/localVfs.ts`
  - Shared local import-path resolution (`import ... from "<path>"` to an absolute `.vx` or `.ts` file), used by the semantic project index, runtime module graph, and LSP cross-file/member-completion features, parameterized by the selected VFS, and able to resolve LSP/editor open-document sessions before files are saved: `compiler/moduleResolution.ts`
  - Project configuration loading from package.json dependencies and tsconfig.json JSX factory defaults used by CLI build/run/test flows: `compiler/project.ts`
  - Module resolution tests: `compiler/moduleResolution.test.ts`
- Semantic analysis:
  - Public analysis API: `compiler/analysis/Analysis.ts`
  - Scope/symbol binding: `compiler/analysis/Binder.ts`
  - Type checking and semantic diagnostics: `compiler/analysis/TypeChecker.ts`
  - Shared cached one-pass top-level declaration indexing for runtime/ambient/program statement arrays reused by binder/type-checker: `compiler/analysis/declarationIndex.ts`
  - Shared structural type-text parsing/splitting and substitution helpers: `compiler/analysis/typeNames.ts`
  - Type-name helper tests: `compiler/analysis/typeNames.test.ts`
  - Declaration-index tests: `compiler/analysis/declarationIndex.test.ts`
  - Project semantic index/cache with precise top-level declaration kinds for classes, interfaces, type aliases, functions, variables, and extension members: `compiler/analysis/projectIndex.ts`
  - Project index tests: `compiler/analysis/projectIndex.test.ts`
  - Analysis model/types: `compiler/analysis/model.ts`, `compiler/analysis/types.ts`
  - Analysis issue codes/contracts: `compiler/analysis/issueCodes.ts`
  - Analysis tests: `compiler/analysis/Analysis.test.ts`
- Embedded runtime declarations:
  - Shared runtime-declaration host contract that lets Node/browser adapters provide bundled declaration sources without hard-wiring shared compiler code to `fs/path/url`: `compiler/runtime/declarationHost.ts`
  - Node runtime-declaration host that reads bundled `compiler/runtime/es2025.d.ts` and `compiler/runtime/dom.d.ts` from disk for the CLI/LSP/test environment: `compiler/runtime/nodeDeclarationHost.ts`
  - Shared ECMAScript runtime declaration parsing/cache logic plus the Node bootstrap wrapper used by compiler consumers: `compiler/runtime/ecmascriptDeclarations.shared.ts`, `compiler/runtime/ecmascriptDeclarations.ts`
  - Shared DOM runtime declaration parsing/cache logic plus the Node bootstrap wrapper used when a project requests `compilerOptions.lib` with `"dom"`: `compiler/runtime/domDeclarations.shared.ts`, `compiler/runtime/domDeclarations.ts`
  - Shared browser-safe cache for parsed runtime declaration programs, backed by `localStorage` when available and an in-memory fallback otherwise: `compiler/runtime/programCache.ts`
- Emitter / transpilation:
  - Lowering pass boundary: `compiler/runtime/lowering.ts`
  - Lowering tests: `compiler/runtime/lowering.test.ts`
  - JavaScript emission: `compiler/runtime/emitter.ts`
  - Emission tests: `compiler/runtime/emitter.test.ts`
  - Transpile orchestration: `compiler/runtime/transpile.ts`
  - Local module-graph bundling for execution and CLI ESM bundle preparation (resolves and inlines a `.vx` entry file together with its transitively imported local `.vx` and `.ts` modules so cross-file classes/operators/extension properties and TypeScript runtime declarations resolve before downstream JavaScript/package bundling): `compiler/runtime/moduleGraph.ts`
  - Module-graph bundling tests: `compiler/runtime/moduleGraph.test.ts`
  - Runtime tooling helpers: `compiler/runtime/tooling.ts`
  - VexaScript test-file discovery/orchestration and inline test helpers used by the CLI test command: `compiler/runtime/testRunner.ts`
  - Test-runner orchestration tests: `compiler/runtime/testRunner.test.ts`
  - Transpile tests: `compiler/runtime/transpile.test.ts`
  - Runtime integration tests: `compiler/runtime/runtime.integration.test.ts`
- Runnable samples and sample-test harness: `samples/`, `samples/samples.test.ts`
  - Each sample directory is discovered when it contains expected.txt; the harness runs main.vx with runFile and compares captured console.log output to expected.txt.
  - Sample-local package.json files are installed with pnpm install before execution when node_modules is missing, so samples can demonstrate npm package declarations and runtime dependencies.
  - Sample-local tsconfig.json files are loaded by `compiler/project.ts`; they can set JSX factories/import sources and `compilerOptions.lib` entries such as `dom` for DOM ambient declarations.
  - DOM-emulation sample: `samples/virtual-dom/` uses a lightweight local DOM shim plus `tsconfig.json` with `lib: ["es2025", "dom"]` to validate DOM globals and DOM element types without a heavy third-party runtime.
  - DefinitelyTyped sample: `samples/minimist/` uses the runtime-only `minimist` package together with `@types/minimist` to validate fallback resolution for npm packages that keep declarations in `node_modules/@types`.
  - Delegated-state sample: `samples/delegated-state/` validates end-to-end execution of Kotlin-style delegated variables backed by function and object delegates.
  - Proxy theme-hooks sample: `samples/proxy-theme-hooks/` validates VexaScript construction of ECMAScript `Proxy` instances and runtime `get`, `set`, and `has` traps over theme objects.
  - Class-delegate sample: `samples/class-delegate/` validates interface-member forwarding generated from class `by` delegates.
  - Sync orchestration sample: `samples/sync-orchestration/` validates local-module imports of exported async functions plus `sync` auto-awaiting across call arguments, arrays, object literals, and `go` opt-out promises.
  - Syntax tour sample: `samples/syntax-tour/` is a multi-file runnable fixture that exercises the broad supported VexaScript syntax surface, JSX factory configuration, local imports, declarations/types, classes, extensions/operators, delegates, control flow, and async `sync` output.
  - Expression lab sample: `samples/expression-lab/` is a larger multi-file calculator fixture with lexer, parser, AST, optimizer, evaluator, and pretty-printer modules that stress imports, classes, enums, sequences, calls, assignments, loops, and heavier expression workloads for both correctness and performance.
  - TypeScript import sample: `samples/typescript-import/` validates a `.vx` entry importing a local `.ts` module with TypeScript enums, interfaces, type aliases, classes, generics, destructuring, arrow functions, and async functions that are transpiled into the bundled runtime output.
  - JSON/text asset import sample: `samples/json-text-import/` validates a `.vx` entry importing local `.json` and `.txt` assets as default imports that are inlined into the bundled runtime output.
- Formatter:
  - Formatter logic: `compiler/runtime/formatter.ts`
  - Formatter tests: `compiler/runtime/formatter.test.ts`
  - LSP formatting adapter: `compiler/lsp/formatting.ts`
- Embedded syntax definitions:
  - Shared editor-syntax generators used by the CLI and editor integrations: `compiler/syntax.ts`
  - Syntax generator consistency tests: `compiler/syntax.test.ts`
- Shared async file helpers live in `compiler/utils/fs.ts`, and shared async process helpers live in `compiler/utils/io.ts`. Reuse them instead of duplicating `fileExists`, directory probes, or child-process wrappers.

### Tooling and Integration Pieces

- Compilation pipeline (separate shared parse and parse + analysis artifacts):
  - Parse phase: `compiler/pipeline/parse.ts`
  - Parse phase tests: `compiler/pipeline/parse.test.ts`
  - Compile phase: `compiler/pipeline/compile.ts`
  - Compile phase tests: `compiler/pipeline/compile.test.ts`
- CLI:
  - CLI entrypoint and commands: `compiler/cli.ts`
  - Shared root-package compiler version loader used by the CLI and MCP server so `package.json` stays the source of truth: `compiler/compilerVersion.ts`
  - CLI tests: `compiler/cli.test.ts`
  - `test` command delegates test-file discovery and helper injection to `compiler/runtime/testRunner.ts`, keeping CLI command parsing separate from test orchestration.
  - `syntax` command prints embedded VexaScript syntax definitions for popular editor targets such as Monaco, VS Code/TextMate, and CodeMirror.
- Monaco browser plugin (project root: `plugins/monaco/`):
  - Static Monaco demo entrypoint: `plugins/monaco/src/main.ts`
  - Monaco-to-compiler provider adapter (in-process; does NOT use LSP, calls the
    compiler's `compiler/lsp/*` feature functions directly and maps them to
    Monaco's `monaco.languages.register*Provider` APIs to reach VS Code feature
    parity): `plugins/monaco/src/compiler-providers.ts`
  - Shared Monaco provider conversion helpers for preserving LSP diagnostic metadata
    such as `source`/`code` when adapting Monaco markers to compiler quick-fix
    inputs: `plugins/monaco/src/providerConversions.ts`
  - Optional LSP-over-Web-Worker path (alternative transport, not wired into the
    default demo; reuses shared single-file LSP feature collectors such as the
    code-action aggregator with browser-safe empty source roots):
    `plugins/monaco/src/lsp-providers.ts`, `plugins/monaco/src/compiler-client.ts`,
    `plugins/monaco/src/lsp-worker.ts`, `plugins/monaco/src/lsp-client.ts`,
    `compiler/lsp/server-browser.ts`
  - Browser stubs for Node built-ins used by shared compiler modules:
    `plugins/monaco/src/browser-stubs/`
  - Client-side Monaco sample shell with workspace tabs, left-hand file tree, cross-tab navigation history (back/forward), and on-demand model creation over a browser-only virtual workspace: `plugins/monaco/src/main.ts`
  - Client-side virtual-workspace and persistence helpers (bundled sample + runtime declarations + `localStorage`): `plugins/monaco/src/workspace.ts`
  - Monaco virtual file-system adapter that exposes open/editor workspace files through the compiler's async VFS interface: `plugins/monaco/src/workspaceVfs.ts`
  - Monaco sample navigation-history state helpers used by toolbar/shortcut back-forward navigation: `plugins/monaco/src/navigationHistory.ts`
  - Code-lens command bridge translating LSP-style commands to native Monaco commands: `plugins/monaco/src/codeLensCommands.ts`
  - Shared Monaco theme definitions for the sample UI, including distinct styling for regular and documentation comments: `plugins/monaco/src/theme.ts`
  - Monaco package manifest and Vite config: `plugins/monaco/package.json`, `plugins/monaco/vite.config.ts`
- LSP server and features:
  - Server entrypoint: `compiler/lsp/server.ts`
  - MCP codebase navigation server and tests exposing symbols, hover/definition/references/signature help, rename operations, and package-version metadata to MCP clients: `compiler/mcpServer.ts`, `compiler/mcpServer.test.ts`
  - Project-level analysis adapter: `compiler/lsp/projectAnalysis.ts`
  - Session cache: `compiler/lsp/analysisSession.ts`
  - Completion, including member/extension completion over imports resolved through the shared module resolver: `compiler/lsp/completion.ts`
  - Diagnostics: `compiler/lsp/diagnostics.ts`
  - Cross-file type diagnostics: `compiler/lsp/crossFileTypeDiagnostics.ts`
  - Member diagnostics: `compiler/lsp/memberDiagnostics.ts`
  - Diagnostic code mapping and shared semantic diagnostic parsing for quick fixes: `compiler/lsp/diagnosticCodes.ts`
  - Shared position/range helpers for LSP quick fixes and document features: `compiler/lsp/ranges.ts`
  - Shared AST node search helpers for LSP quick-fix target lookup: `compiler/lsp/nodeSearch.ts`
  - Navigation/rename/references: `compiler/lsp/navigation.ts`, `compiler/lsp/crossFileNavigation.ts`
  - Signature help: `compiler/lsp/signatureHelp.ts`
  - Document/workspace symbols: `compiler/lsp/symbols.ts`
  - Document structure/navigation services: `compiler/lsp/documentFeatures.ts`
  - Semantic tokens: `compiler/lsp/semanticTokens.ts`
  - Inlay hints: `compiler/lsp/inlayHints.ts`
  - Await gutter decorations (lines with an explicit `await` in async/sync functions or an implicit auto-`await` inside `sync` functions, served via the custom `vexa/autoAwaitDecorations` request and the Monaco glyph margin): `compiler/lsp/autoAwaitDecorations.ts`
  - Code action orchestration: `compiler/lsp/codeActions.ts`
  - Shared code-action collection (used by the Node LSP server, browser-worker LSP server, and Monaco in-process providers): `compiler/lsp/codeActionsAggregate.ts`
  - Quick fixes: `compiler/lsp/importFixes.ts`, `compiler/lsp/typeFixes.ts`, `compiler/lsp/memberFixes.ts`, `compiler/lsp/callFixes.ts`, `compiler/lsp/keywordFixes.ts`, `compiler/lsp/interfaceImplementationFixes.ts`, `compiler/lsp/stringTemplateFixes.ts`, `compiler/lsp/thisFixes.ts`
  - Function shorthand quick fixes: `compiler/lsp/functionShorthandFixes.ts`
  - Trailing-lambda quick fix (moves a brace lambda written as the last call argument out of the parentheses, e.g. `foo(a, { x -> ... })` to `foo(a) { x -> ... }`): `compiler/lsp/trailingLambdaFixes.ts`
  - Explicit return type quick fix (adds an inferred return type annotation after the parameter list of a function/method declaration that has no explicit return type, e.g. `function add(a, b) { ... }` to `function add(a, b): number { ... }`): `compiler/lsp/returnTypeFixes.ts`
  - Empty class body quick fix (removes the empty braces from a class that declares no members, e.g. `class TimeSpan(val ms: number) { }` to `class TimeSpan(val ms: number)`): `compiler/lsp/emptyClassBodyFixes.ts`
  - Shared cross-file top-level declaration resolution helpers: `compiler/lsp/declarationResolver.ts`
  - Class/interface resolution helpers: `compiler/lsp/classResolver.ts`
  - Shared declaration-documentation extraction for `///` and block doc comments used by completion/signature/hover surfaces: `compiler/lsp/documentation.ts`
  - Imported type-declaration collection feeding cross-file extension-method/`this` resolution into the per-document analysis (via `Analysis` `externalDeclarations`): `compiler/lsp/importedDeclarations.ts`
  - LSP tests: `compiler/lsp/*.test.ts`
- Website and embeddable learning playground (project root: `website/`):
  - 11ty configuration and static-site build surface: `website/eleventy.config.mjs`, `website/src/index.njk`, `website/src/syntax.njk`, `website/src/cli.njk`, `website/src/embed.njk`, `website/src/playground.njk`, `website/src/blog/index.njk`, `website/src/blog/article1.njk`, `website/src/404.njk`, `website/src/_includes/layout.njk`, `website/src/assets/site.css`
  - Website build orchestrator, which ensures the compiler CLI bundle exists, regenerates the website-safe JS syntax module from the compiler's canonical syntax source, then runs the esbuild embed bundler and 11ty: `website/scripts/build.ts`
  - Shared website content loaders/renderers, including the `/syntax/` page sourced from `docs/syntax.md`: `website/src/siteContent.ts`, `website/src/siteContent.mjs`
  - Website-only syntax highlighter sources used by Eleventy without importing TypeScript sources during `--watch`: `website/src/syntaxHighlight.ts`, `website/src/syntaxHighlight.mjs`
  - Website content-loader tests: `website/src/siteContent.test.ts`
  - Esbuild-powered embeddable Monaco helper sources for single-file, tabbed, workspace, and full workbench tutorial editors: `website/scripts/buildEmbed.ts`, `website/src/assets/vexa-embed.ts`
  - Generated website build artifacts are created during `website/scripts/build.ts` and `website/scripts/buildEmbed.ts`; keep this map focused on checked-in source files so architecture consistency tests pass in a clean checkout.
  - Website package scripts and type-checking configuration: `website/package.json`, `website/tsconfig.json`
- VS Code extension and syntax highlighting (project root: `plugins/vscode/`):
  - Extension entrypoint (LSP client that launches `compiler/lsp/server.ts` over stdio): `plugins/vscode/extension.js`
  - TextMate grammar generated from the compiler's shared syntax source and checked in for packaging: `plugins/vscode/syntaxes/vexa.tmLanguage.json`
  - VS Code extension manifest/config and checked-in language configuration generated from the compiler's shared syntax source: `plugins/vscode/package.json`, `plugins/vscode/language-configuration.json`
  - Syntax tests: `compiler/vscodeext-syntax.test.ts`
- GitHub automation:
  - Continuous-integration workflow that installs dependencies and runs the repository `pnpm test` suite on pushes to `main`/`master` and on pull requests: `.github/workflows/tests.yml`

### Docs and Specs

- Supported syntax: `docs/syntax.md`
- Pending technical tasks/backlog: `docs/tasks.pending.md`
- LSP services status: `docs/lsp.services.md`
- Semantic analysis spec: `docs/semantic.spec.md`
- Transpilation design note: `docs/transpilation.design.md`
- Architecture map consistency guard: `compiler/architectureMap.test.ts`

### Test Fixtures and Auxiliary Utilities

- Runtime sample fixture: `testFixtures/sample.vx`
- Third-party declaration samples: `testFixtures/PIXI.d.ts`, `testFixtures/threejs.d.ts`
- TypeScript compatibility fixture: `testFixtures/typescript-supported.d.ts`
- Fixture tests: `testFixtures/@test.test.ts`
- Shared async file helpers: `compiler/utils/fs.ts`
- Shared async process/I/O helpers: `compiler/utils/io.ts`, tests: `compiler/utils/io.test.ts`
- Reader utilities used by parser/tokenizer:
  - `compiler/utils/ListReader.ts`, tests: `compiler/utils/ListReader.test.ts`
  - `compiler/utils/StrReader.ts`, tests: `compiler/utils/StrReader.test.ts`
