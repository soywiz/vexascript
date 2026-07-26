# Native link optimization and JavaScript bundling

The native `cpp link`/`cpp run` commands previously hard-coded `-O2`, while
the C++-compiled CLI still routed `bundle` to an explicit “not available”
error. This made native compiler measurements and debug-oriented native CLI
workflows unnecessarily dependent on the Node-hosted CLI.

The link commands now accept exactly one of `-O0`, `-O1`, or `-O2`, with `-O2`
as the default. The selected level is passed through the Node adapter into the
native compiler argument builder and is stored with the executable cache key.
Without that cache key, changing optimization could silently reuse an older
binary when the generated C++ had not changed.

The first bundling implementation attempt used a structured JSON link-cache
object and richer typed adapter parameters. The native emitter inferred the
JSON callback as a string-returning coroutine, could not represent the typed
class-vs-record JSX parameter at the call boundary, and exposed the extra
linker parameter mismatch in the native `cliIo` replacement. The durable fix
keeps the cache as a small textual fingerprint and preserves the native
adapter's dynamic parameter boundary.

An initial bundling implementation delegated to the JavaScript CLI through the
asynchronous native process bridge. Although that made a small fixture pass, it
was rejected because the native executable did not actually contain the
bundler: it still depended on a Node-hosted source CLI, packaged CLI, or external
`vexa` executable. Passing an integration test through that route would have
hidden the missing self-hosted functionality.

The final implementation compiles the bundler itself to C++. The native
`cliShared` adapter builds VexaScript/TypeScript local modules, resolves package
declarations, loads embedded DOM declarations, and passes virtual module sources
to the same `cli/nodeModuleBundle.ts` package graph used by the JavaScript CLI.
No child process or JavaScript CLI fallback is involved.

Parsing every published package module was also unnecessary and expensive.
Package `.js`, `.mjs`, and `.cjs` files now use the existing tokenizer to detect
and rewrite the small grammar surface that bundling needs: static imports,
literal dynamic imports, declarations exported in place, named/default exports,
and re-exports. The module body is copied unchanged. Full parsing and emission
remain for TypeScript, TSX, JSX, and VexaScript inputs.

The real Pixi 8 graph exposed several native self-hosting assumptions that small
fixtures did not:

- destructured callbacks over generated class instances were emitted as record
  property reads;
- interpolating a temporary string array relied on JavaScript array coercion,
  which differs from the native runtime;
- `Map | []` iteration attempted to convert the empty-array fallback into a
  native map;
- AST and `AnalysisSymbol` clones written as object spreads/literals became
  records and could not be cast back to generated classes;
- a regular-expression capture used as a string crossed the dynamic native
  boundary;
- declaration resolution selected directories or runtime `.mjs` files before
  their `.d.ts` counterparts; and
- a transpile-only shortcut skipped package typing, producing calls such as
  `Graphics()` and `Vec2()` instead of constructor calls and losing extension
  lowering.

The durable fixes use generated class constructors, explicit optional branches,
direct string operations, declaration-first resolution, and one typed module
analysis path regardless of whether semantic diagnostics are enforced. A native
`-O0` CLI now bundles `samples/pixi/html.vx` into a syntactically valid browser
bundle. A real browser run produced a 480×320 Pixi canvas and logged
`pixi-ready`.
