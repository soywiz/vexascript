# Native runtime source layout and relocatable PCH cache inputs

## Context

The native runtime had grown into one 10,457-line header at the root of
`native/`. BigInt and UTF/platform helpers were also header-only, even though the
native build linked a cached runtime static library. This made API ownership hard
to review and kept substantial non-template implementation in every generated
translation unit.

## What changed

The runtime sources now live under `native/runtime/`. `runtime.hpp` is a small
public umbrella over focused internal category headers for arrays, collections,
Date, strings, regular expressions, Intl, binary data, promises, JSON, objects,
tasks, math, console, and their dependency layers. BigInt and UTF helpers now
have declaration headers and separately compiled implementations. The cached
runtime archive contains objects for `runtime.cpp`, `bigint.cpp`, and `utf.cpp`.

Generated code includes `runtime/runtime.hpp`, while Clang builds can suppress
that textual include when a compatible PCH has already supplied the umbrella.
Packaging includes the complete `native/runtime/` directory rather than a small
manually synchronized list of runtime files.

## Investigation branches and failures

The first mechanical split used contiguous top-level declaration boundaries.
That preserved compilation order, but it placed `vexaRuntimeName`,
`vexaPlatformName`, and `performanceNow` at the end of `date.hpp`. Compilation
alone could not detect that architectural error. The categories were refined
semantically, the platform helpers were moved to `platform.hpp`, and packaging
tests now assert representative ownership boundaries.

The first PCH fix only guarded the generated textual runtime include. That
prevented duplicate definitions when the same content was loaded from the PCH
and an installed package path, but it did not make the PCH durable: Clang still
records the paths of its input headers and rejected the cached PCH after the
temporary package directory was deleted.

The durable fix copies the content-addressed runtime source tree to a stable
cache directory before building the PCH. The mirror retains the public
`native/runtime/` layout and the two dependency archives, so `__FILE__`-based
native self-host discovery still resolves a complete native root. Both the
runtime archive and PCH are built from that stable mirror.

The Linux CI job also exposed an option-precedence bug. Its legacy
`VEXA_NATIVE_SINGLE_FILE=1` environment setting conflicted with tests that
explicitly requested `--module-files`. Explicit command-line layout selection
now wins over the legacy environment default.

## Cache scope lesson

Content-addressed runtime artifacts are valuable within one machine or CI run,
but persisting every runtime hash in GitHub Actions would accumulate variants on
nearly every runtime edit. The workflow now persists only the more stable
Oilpan and mimalloc directories and libraries. Runtime archives, PCH files, and
their source mirrors remain runner-local.

## Regression coverage

- The JavaScript sample runner skips native-only Float16 DataView checks on
  Node.js 22 while the native smoke still executes all layouts.
- Explicit `--module-files` is tested with the legacy single-file environment
  variable enabled.
- Installed-package native compilation verifies that a PCH can be reused after
  its temporary package directory disappears.
- Packaging tests verify the complete runtime directory and representative API
  ownership across category headers.

## Execution metadata

- Provider: OpenAI
- Model: Unavailable (not exposed by runtime)
