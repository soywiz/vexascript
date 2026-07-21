# Portable Oilpan linking and Windows CI

## Linux linker failure after the preprocessor fix

Once the GCC `__has_warning` preprocessor failure was fixed, the Ubuntu job
compiled the complete Oilpan static library and exposed the next independent
failure while linking generated executables:

```text
undefined reference to `__start_gc_info_section'
hidden symbol `__start_gc_info_section' isn't defined
```

`CPPGC_ENABLE_OBJECT_SECTION_GCINFO` makes cppgc discover GC metadata through
linker-generated section boundary symbols. That path works for the existing
AppleClang build, but the standalone Linux/GNU link did not provide the expected
hidden start symbol. Linux and Windows now use cppgc's portable GC-info table;
the object-section optimization remains enabled only on Apple platforms. The
same selection is applied to both the Oilpan library and each generated program
so their header-level ABI stays consistent.

## Windows support

The previous native adapter assumed a Unix host even though it already knew
that Windows executables use an `.exe` suffix. It invoked `unzip`, passed
`-pthread` and `-ldl`, and the trimmed Oilpan archive contained no Windows
platform, stack-trace, or register-preservation implementation.

The unified `g++` path now selects MinGW Makefiles on Windows, defines the
supported Windows API level, links the required Windows system libraries, and
normalizes explicit executable outputs to `.exe`. Archive extraction uses
`cmake -E tar`, avoiding a separate platform-specific extraction dependency.
The vendored archive includes the required V8 Win32 sources and a GNU-assembler
implementation of V8's Windows x64 register-preservation contract. The platform
sources are pinned to V8 commit
`3e43c9325fcb17b30c435fd8b7b6e4e8c4ebd55b`.

The Windows Actions job runs the complete `pnpm test` suite rather than a
header-only or transpilation-only check. This ensures a clean runner compiles,
links, and executes the native smoke programs through the public CLI.

## Clean-cache race found during validation

Changing the archive invalidated the shared temporary cache and made several
Node test workers extract and configure the same CMake directory concurrently.
One configure process observed another process's partially created compiler-ID
directory and failed. A successful warm-cache rerun would have hidden this CI
hazard.

The native cache now uses an asynchronous cross-process directory lock around
both extraction and library construction. Waiters recheck the static library
after acquiring the lock, so one build remains the source of truth. Locks have
bounded waiting and stale-lock recovery. A focused concurrency regression and a
full suite run from a deleted cache verify the cold-start behavior.

## Investigation notes

- A local macOS run could validate the Apple path but could not compile the
  Win32 sources or reproduce the GNU/Linux linker behavior.
- A Docker-based MinGW cross-check was considered, but the local Docker daemon
  was not running. Installing a host-wide cross toolchain solely for this check
  would have changed the developer machine more than necessary; the dedicated
  clean Windows Actions runner is the authoritative integration environment.
- Merely adding `windows-latest` while skipping native tests would not validate
  the requested feature. The Windows job therefore exercises the full suite.
