# Native test and cache separation

## What changed

The regular Node test discovery was running C++ compilation and link tests
alongside compiler and LSP checks. Native tests now live under `tests/native/`
with a `.native.ts` suffix, so automatic discovery for `pnpm test` excludes
them. `pnpm test:native` type-checks and executes the explicit native entrypoint,
and CI runs the normal and native suites in separate steps.

Oilpan and mimalloc extraction/build outputs were previously rooted in the
operating system temporary directory. They now use `~/.vexascript/native`, with
one versioned source directory per dependency and platform-/architecture-named
static-library artifacts, which preserves expensive dependency builds across
temporary-directory cleanup and native test runs.

## Regression guidance

Keep native tests under `tests/native/` with the `.native.ts` suffix and import
them from `tests/native/index.native.ts`. If a native test imports an asset using
`?text`, include its ambient declaration in `tsconfig.native.json`; a narrow
test project otherwise does not inherit it merely by importing compiler code.

Native dependency caches must remain outside project output and the temporary
directory. The focused cache-path tests protect the default location and naming;
full native tests exercise actual Oilpan and mimalloc creation.
