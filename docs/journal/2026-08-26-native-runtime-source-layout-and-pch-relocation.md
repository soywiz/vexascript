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
runtime archive originally contained objects for `runtime.cpp`, `bigint.cpp`,
and `utf.cpp`. It now compiles every focused `.cpp` beside its `.hpp`, moving
all concrete implementations out of the umbrella. Templates and `constexpr`
functions remain in headers because their definitions must be visible at the
point of instantiation.

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

The complete native suite then found one more path-identity case: a hand-written
C++ test included the checkout umbrella while the PCH contained the mirrored
umbrella. `#pragma once` is path-sensitive and therefore admitted both copies.
A conventional umbrella include guard now makes the PCH and textual include
mutually exclusive even when Clang sees different absolute paths.

Splitting the implementations also exposed two mechanical hazards worth
preserving. Libclang source offsets are UTF-8 byte offsets, so source rewriting
must translate them before indexing a Unicode string; otherwise a literal such
as the microsecond `μ` in Intl shifts every later edit. Out-of-line definitions
also require nested return types such as `Runtime::TimerId` and
`DynamicArrayRange::Iterator` to be explicitly qualified before the function
name establishes class scope. Compiling every new translation unit separately
before linking caught both classes of error quickly.

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

## Operator lowering lesson

The runtime previously offered `callDynamicOperator` and registered class
operators under private `__vexa_operator:*` property keys. This was neither an
ECMAScript behavior nor necessary for VexaScript: semantic analysis already
records the selected operator symbol and both emitters lower it to the concrete
mangled method. Keeping the fallback could conceal a missing resolution and make
native behavior diverge from JavaScript. The dynamic helper, registrations, and
fallback calls were removed; unresolved dynamic `Value` operations now follow
only their ordinary primitive/object semantics.

## Regression coverage

- The JavaScript sample runner skips native-only Float16 DataView checks on
  Node.js 22 while the native smoke still executes all layouts.
- Explicit `--module-files` is tested with the legacy single-file environment
  variable enabled.
- Installed-package native compilation verifies that a PCH can be reused after
  its temporary package directory disappears.
- Packaging tests verify the complete runtime directory and representative API
  ownership across category headers.
- The multi-file native language smoke groups compiler semantics under
  `language-features/`; its custom-operator case executes arithmetic, unary,
  comparison, index-get, and index-set overloads through JavaScript and the
  linked native executable. The smoke deliberately validates observable output
  rather than generated-source text.
- JavaScript and native execution share one `expected.txt`. Native console
  inspection distinguishes array display (`[ 1, 2 ]`) from ECMAScript
  `Array.prototype.toString()` (`1,2`) and displays BigInt values with the
  JavaScript `n` suffix, preventing backend-specific expectation drift.

## Execution metadata

- Provider: OpenAI
- Model: Unavailable (not exposed by runtime)
