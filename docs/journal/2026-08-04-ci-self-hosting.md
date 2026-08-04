# CI compiler self-hosting bootstrap

## Context

The repository already had local JavaScript self-hosting and native CLI smoke
coverage, but CI did not run the two compiler generations as one explicit
bootstrap contract. It also did not expose comparable `tsc`, JavaScript, and
C++ timings separately from the ordinary test logs.

## Change

The dedicated `self-host` GitHub Actions job runs on its own Ubuntu runner. It
emits a runnable compiler with `tsc`, stages the required runtime/native assets,
and then performs two JavaScript bundle generations and two native C++
compile/link generations. Each pair is compared byte-for-byte and reports a
SHA-256 digest when it reaches a fixed point.

The timing table is written to `GITHUB_STEP_SUMMARY`, so it appears in the
workflow-run summary instead of being mixed into the normal command output.
The driver still publishes the table when a stage fails; the job exits non-zero
after all independent stages have had a chance to report their state.

## Current limitation

The existing compiler does not currently pass the TypeScript check on this
branch. The new job intentionally preserves that failure rather than weakening
the check or hiding it behind transpile-only mode. The summary therefore acts
as the durable acceptance surface while compiler fixes bring the bootstrap
stages back to green.
