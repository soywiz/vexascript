# Sample LSP Deprecated-Member Hotspot

## What failed

The `all sample LSP sessions` suite had grown slow enough to be painful to run,
landing around 24 seconds locally. The slowest samples were the ones with large
ambient typings or larger editor surfaces, especially `pixi`, `threejs`, and
`node`.

An early hypothesis was that the fake LSP open-session helper was doing too
much work unrelated to opening a file, because it also triggered a synthetic
`didChangeConfiguration`, a redundant `change` event, and a full-document
`codeAction` request.

## Root cause

Profiling the real LSP path showed the dominant cost was elsewhere:

- cold `AnalysisSessionCache.getForDocumentAsync(...)` was noticeable, but not
  the main culprit for the worst samples
- deprecated-member analysis dominated the request burst much more often than
  token building or sync diagnostics
- the deprecated-member collector repeatedly resolved the same `type + member`
  combinations and re-entered cross-file hover/member resolution even when many
  member expressions shared the same receiver type

For the Pixi sample, the expensive phases were:

- `deprecated diagnostics`
- `deprecated semantic modifiers`

Both were ultimately backed by the same deprecated-member walk.

## What helped

- The existing latency reproduction script under
  `.codex/skills/vexascript-lsp-infra-debugging/scripts/profile_pixi_lsp_latency.ts`
  was the fastest way to isolate the expensive phases without VS Code noise.
- Reusing a shared class-resolver cache and memoizing deprecated-member status
  by `typeToString(receiverType) + memberName` removed a large amount of
  repeated cross-file work while preserving behavior.

After the cache change, the Pixi latency script dropped roughly from:

- deprecated diagnostics: ~482ms -> ~299ms
- deprecated semantic modifiers: ~428ms -> ~192ms
- concurrent diagnostic/workspace/semantic burst: ~1176ms -> ~508ms

The full `all sample LSP sessions` suite also dropped from roughly 24 seconds
to about 20 seconds.

## Final decision for active editor flows

After profiling the remaining hotspots, deprecated-member analysis was still one
of the most expensive parts of the Pixi open burst, and it was not providing
reliable user value in practice. We removed it from active editor-facing flows:

- LSP pull diagnostics
- LSP workspace diagnostics
- LSP semantic tokens
- Monaco/embed workspace diagnostics
- Monaco/embed semantic tokens

The helper code and its focused tests can remain for future rehabilitation, but
the active request paths no longer pay that runtime cost.

With that removal, the real sample-session timings improved again. In focused
runs, `samples/pixi.test.ts` dropped its LSP-open path to roughly 3.0 seconds,
and `all sample LSP sessions` dropped to about 16 seconds.

## Follow-up: cheap deprecated semantic tokens

The original deprecated-member path was slow mostly because it rediscovered
deprecation from the outside:

- resolve the member,
- read string documentation,
- regex-scan `@deprecated`,
- and in some cases fall back to hover text.

That was the wrong abstraction boundary. The cheaper shape is to parse
documentation once, carry structured metadata on resolved declarations, and let
semantic tokens read a `deprecated` boolean directly from the resolved member.

The follow-up implementation now does that:

- `documentation.ts` exposes structured documentation metadata
- resolved class/interface members carry `deprecated?: boolean`
- deprecated semantic token collection resolves the member directly through the
  class/interface resolver cache, with no hover fallback

After that rewrite, deprecated semantic tokens were re-enabled for the active
LSP/embed semantic-token paths without bringing back the old latency spike. In
focused reruns, `samples/pixi.test.ts` stayed around 3.2 seconds for the LSP
open path, and `all sample LSP sessions` stayed around 17.1 seconds.

## What did not help

- Simplifying the fake open-session helper by removing the synthetic change,
  config refresh, and code-action request did not produce a stable improvement
  in the suite-level runtime. The total time regressed on reruns because the
  main bottleneck was not there.
- Reusing one fake server across all samples also did not help reliably. The
  dominant costs were still inside per-sample LSP work, and the added lifecycle
  complexity did not buy a stable speedup.

## Regression guidance

- When LSP latency spikes on real samples, profile the same request surfaces
  first before trimming test harness behavior.
- Treat deprecated-member scanning as a shared hot path for both diagnostics and
  semantic tokens.
- If a cross-file helper is called once per member expression, check whether the
  result can be reused per resolved receiver type/member pair instead of per
  syntax occurrence.

## Follow-up: node workspace cold-open profiling

After the deprecated-member work, the `node` sample was still one of the slower
LSP-open cases. A first coarse profile misleadingly suggested
`workspace/diagnostic` was still expensive, but timing the real handler path
showed the actual split was different:

- `textDocument/diagnostic::analysisSession`: about 646-726ms
- `workspace/diagnostic`: about 100ms

That changed the optimization target back to cold analysis-session setup, not
workspace diagnostics.

Two follow-up improvements helped:

- preserve diagnostic/session caches across configuration changes that only
  toggle editor features such as inlay hints, code lens, and timing logs
- cache more node-module typing work, including per-declaration dependency/name
  indexes in `collectAllImportedDeclarations` and parsed/source `.d.ts` file
  reuse in `nodeModulesTypings.ts`

The micro-profile for `samples/node/main.vx` stayed noisy across runs, but the
real sample suite improved in the user-visible metric:

- `opens node without LSP error diagnostics`: about 1209ms -> about 1069ms in a
  focused run
- `all sample LSP sessions`: about 7856ms -> about 7052ms in a focused run

The important lesson is that the synthetic open burst can over-attribute time
to later requests when the real cold cost was already paid inside the first
document diagnostic. When timings look surprising, add phase timing inside the
actual LSP handlers before optimizing the wrong request surface.

## Follow-up: keep the full open burst, but overlap it

Another useful optimization was in the test harness itself, without removing
any requests. The original `openEntrypointInLspSession` helper serialized most
of the editor-open burst:

- inlay hints
- folding ranges
- document symbols
- diagnostics
- semantic tokens
- workspace diagnostics

That was more conservative than VS Code and also prevented the server from
sharing in-flight work across request surfaces as effectively as it does under a
real burst.

The safer change was:

- keep the exact same request set
- await document diagnostics before code actions, because code actions depend on
  those diagnostics
- let the other independent requests run concurrently

This preserved the value of the sample suite as a detector for hangs,
exceptions, and cache-invalidating regressions, while reducing wall-clock time
through shared pending promises inside the real server caches.

After that harness change, focused sample-LSP runs improved again:

- `all sample LSP sessions`: about 7052ms -> about 6791ms
- full `pnpm test`: about 14.7s -> about 13.4s
