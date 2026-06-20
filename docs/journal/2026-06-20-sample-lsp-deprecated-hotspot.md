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

## What did not help

- Simplifying the fake open-session helper by removing the synthetic change,
  config refresh, and code-action request did not produce a stable improvement
  in the suite-level runtime. The total time regressed on reruns because the
  main bottleneck was not there.

## Regression guidance

- When LSP latency spikes on real samples, profile the same request surfaces
  first before trimming test harness behavior.
- Treat deprecated-member scanning as a shared hot path for both diagnostics and
  semantic tokens.
- If a cross-file helper is called once per member expression, check whether the
  result can be reused per resolved receiver type/member pair instead of per
  syntax occurrence.
