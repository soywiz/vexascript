# AGENTS

## Project context

VexaScript is a language derived from TypeScript with some features and ideas from Swift, Kotlin, C# and other languages.

- Monaco editor theme configuration for the website embeds, including editor token colors for VexaScript-specific comment styling, lives in `website/src/assets/monaco/theme.ts`.
- Shared LSP declaration-documentation extraction for `///` and block doc comments lives in `compiler/lsp/documentation.ts`.
- Instance-member `this.` add/remove quick fixes live in `compiler/lsp/thisFixes.ts`.

## Important

- Do not use synchronous I/O API calls. Only use asynchronous I/O APIs. The compiler is intended to run both in node and the browser.
- Do not use top-level awaits as they are problematic.
- Except for the CLI and explicitly Node-only adapters, compiler modules must not depend on Node.js APIs. Shared compiler/runtime code should stay browser-compatible.


## Design principles

- Follow KISS, DRY, and clean code principles: keep implementations simple, avoid duplication, and prefer readable, maintainable designs over case-by-case branching.
- Prefer unified code paths. When similar functionality exists, look for a common route and architecture instead of adding parallel implementations.
- For areas such as module imports, symbol processing, hover, go to declaration, signature helpers, and similar compiler or LSP features, keep behavior simple and unified so each different combination of cases does not create its own branch that must be tested and maintained separately.

## Commands

- Run tests once: `pnpm test`
- Validate compiler CLI is working: `pnpm cli vexa testFixtures/sample.vx`
- Keep the `test` script as `tsc --noEmit && node --import tsx --test --test-reporter spec`. Do not add explicit test-file globs or `rg`/`find` enumeration to it unless the current autodiscovery behavior actually breaks. In this repository, Node's test runner with `--import tsx` already discovers and runs the `.test.ts` suite correctly.
- Run tests with coverage: `pnpm coverage`
- Run vscode with the plugin+lsp: `pnpm code`
- Print embedded editor syntax bundles: `pnpm tsx cli/cli.ts syntax --monaco|--vscode-grammar|--vscode-configuration|--codemirror`

## File Structure & Maintenance Rule

- In docs/file.structure.md there is a explanation of the file structure of the repository. Keep it updated.
- If a new architectural piece/module is added (new compiler phase, new service, new plugin integration, new docs surface, etc.), this Architecture Map in `docs/file.structure.md` must be updated in the same change so future agents can understand the repository quickly.
- The Monaco editor support for the website embeds lives in `website/src/assets/monaco/` (browser-only virtual workspace in `workspace.ts`, Monaco/LSP conversions in `providerConversions.ts`, theme in `theme.ts`); the embed shell itself is `website/src/assets/vexa-embed.ts`.
- Shared async file helpers live in `compiler/utils/fs.ts`, and CLI-only async process helpers live in `cli/io.ts`. Reuse them instead of duplicating `fileExists`, directory probes, or child-process wrappers.
- Repository samples live under `samples/<name>/`. The sample test harness runs directories that contain expected.txt, installs package.json dependencies with pnpm install when node_modules is absent, and lets each sample provide its own VexaScript config file for compiler options such as JSX factories or DOM libraries.

## Testing policy

- We follow TDD (Test-Driven Development).
- Every new feature must include tests in the same change.
- The official test suite runs with node tests.
- Do not modify repository samples just to make tests pass. Changing sample code is only acceptable when it reflects the real intended user-facing API or behavior. Sample-side workarounds that hide compiler, runtime, or LSP bugs do not satisfy project goals.
- Minimum acceptance criterion: a feature is not considered complete without automated tests validating its behavior.
- Before closing any task, the full test suite must pass.
- In LSP/editor tests, prefer the `^^^` cursor-marker style with the shared helper in `compiler/test/sourceWithCursor.ts` instead of hardcoded line/column coordinates whenever practical.
- For UI-facing changes (Monaco plugin, browser flows, visual interactions), validate the final behavior in a real browser before handing off. Use Playwright or another browser automation path when available, and treat that browser check as part of completion rather than an optional extra.
- If tests fail, they must be fixed before finishing the task.
- If requirements change, update tests to match the new expected behavior instead of preserving outdated assertions.
- For editor/LSP cursor-position tests, prefer the shared `^^^` marker helper in `compiler/test/sourceWithCursor.ts` over hardcoded line/column pairs.
- We also validate CLI is working with `pnpm cli vexa testFixtures/sample.vx`

## Language policy

- Everything, including all code, documentation, messages, issue descriptions, etc. must be written in English.

## Documentation policy

- Supported language syntax documentation lives in `docs/syntax.md`. Every time new language syntax support is added it must be updated in the same change.
- Technical/reference documentation lives in `docs/`.
- Active task documents live in `docs/tasks/`.
- Completed task documents live in `docs/tasks/completed/`.

<!-- CODEGRAPH_START -->
## CodeGraph

This project has a CodeGraph MCP server (`codegraph_*` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### When to prefer codegraph over native search

Use codegraph for **structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

| Question | Tool |
|---|---|
| "Where is X defined?" / "Find symbol named X" | `codegraph_search` |
| "What calls function Y?" | `codegraph_callers` |
| "What does Y call?" | `codegraph_callees` |
| "How does X reach/become Y? / trace the flow from X to Y" | `codegraph_trace` (one call = the whole path, incl. callback/React/JSX dynamic hops) |
| "What would break if I changed Z?" | `codegraph_impact` |
| "Show me Y's signature / source / docstring" | `codegraph_node` |
| "Give me focused context for a task/area" | `codegraph_context` |
| "See several related symbols' source at once" | `codegraph_explore` |
| "What files exist under path/" | `codegraph_files` |
| "Is the index healthy?" | `codegraph_status` |

### Rules of thumb

- **Answer directly — don't delegate exploration.** For "how does X work" / architecture questions, answer with 2-3 codegraph calls: `codegraph_context` first, then ONE `codegraph_explore` for the source of the symbols it surfaces. For a specific **flow** ("how does X reach Y") start with `codegraph_trace` from→to — one call returns the whole path with dynamic hops bridged — then ONE `codegraph_explore` for the bodies; don't rebuild the path with `codegraph_search` + `codegraph_callers`. Codegraph IS the pre-built index, so spawning a separate file-reading sub-task/agent — or running a grep + read loop — repeats work codegraph already did and costs more for the same answer.
- **Trust codegraph results.** They come from a full AST parse. Do NOT re-verify them with grep — that's slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name. `codegraph_search` is faster and returns kind + location + signature in one call.
- **Don't chain `codegraph_search` + `codegraph_node`** when you just want context — `codegraph_context` is one call.
- **Don't loop `codegraph_node` over many symbols** — one `codegraph_explore` call returns several symbols' source grouped in a single capped call, while each separate node/Read call re-reads the whole context and costs far more.
- **Index lag — check the staleness banner, don't guess a wait.** When a codegraph response starts with "⚠️ Some files referenced below were edited since the last index sync…", the listed files are pending re-index — Read those specific files for accurate content. Files NOT in that banner are fresh and codegraph is authoritative for them. `codegraph_status` also lists pending files under "Pending sync".

### If `.codegraph/` doesn't exist

The MCP server returns "not initialized." Ask the user: *"I notice this project doesn't have CodeGraph initialized. Want me to run `codegraph init -i` to build the index?"*
<!-- CODEGRAPH_END -->
