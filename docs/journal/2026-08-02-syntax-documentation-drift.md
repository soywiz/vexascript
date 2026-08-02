# Syntax documentation drift across the three reference surfaces

## Problem

The repository had three syntax documents with distinct audiences, but the
maintenance rule only named `docs/syntax.md`. As a result, language changes were
usually documented in the complete reference while
`docs/syntax.differences.md` and `docs/syntax.ai.md` silently drifted.

The problem surfaced again while completing built-in pattern matching. Commits
`bafb19e2` and `4d6cfb22` documented `match` only in the complete reference even
though the compact human and AI references are the places most likely to guide
new code generation.

## Audit

The audit started at `4115f33f`, the commit that introduced the compact syntax
documents, and listed every later commit that changed exactly one of the three
files. Many one-file changes were intentionally detailed TypeScript compatibility,
native-runtime, LSP, or tooling notes that do not belong verbatim in compact
language summaries. The language-specific omissions were concentrated in these
changes:

- `4568ac1e` and `3987e3fc`: cascade expressions and extension accessors;
- `078b3d11`, `a735250f`, and `1344da37`: `<=>`, derived comparisons, and
  undefined-ordering diagnostics;
- `59ff2159`: annotations on class members;
- `e270b3aa` and `68d1898d`: receiver function types, labeled receivers, and
  the precise meaning of implicit `it`;
- `0eeb9d50`: typed `if` and abrupt control-flow expressions;
- `f7767bc4`: `$identifier` template interpolation;
- `bafb19e2` and `4d6cfb22`: condition and subject `match`, arm delimiters,
  built-in patterns, narrowing, and unsupported custom matchers;
- `4811d097`: `?text` imports.

Compound accessor blocks and FFI syntax also needed compact coverage even though
their originating documentation history did not fit the same post-creation
one-file pattern cleanly. Existing compact coverage for cascades and extension
properties was retained; the missing items were added to both compact documents.

## Resolution

`AGENTS.md` now defines syntax documentation as an atomic three-file contract:

- `docs/syntax.md` is the complete reference;
- `docs/syntax.differences.md` explains VexaScript-specific differences to
  TypeScript users;
- `docs/syntax.ai.md` gives compact, unambiguous generation rules.

Every syntax or semantic change must make a meaningful audience-appropriate
update to all three files and verify the changed paths before completion. This
does not mean copying backend implementation detail into every document; it means
that each surface must explicitly teach the user-facing rule at its own level.

During the repair, regular-expression literals were added as another built-in
matcher pattern. This immediately exercised the new contract: all three files
document string-only matching, positive-branch narrowing, portable flags, and
the absence of a custom matcher protocol.

## Dead ends and useful evidence

Treating every one-file historical commit as a missing compact-language entry
would have produced noisy and misleading summaries. Several audited diffs only
expanded native backend parity, TypeScript utility-type support, LSP behavior,
or code-fence labels. The commit list was therefore used to identify
user-visible VexaScript syntax and semantics, not as a mandate to duplicate the
complete reference line for line.

The native suite also exposed unrelated pre-existing self-host compilation
failures. One initial regex-validation implementation used `[...pattern.flags]`,
which added another unsupported self-host string-spread case. Replacing it with
direct portable-flag validation removed the new regression while keeping the
matcher contract explicit.
