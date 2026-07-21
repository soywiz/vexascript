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

The Windows Actions job runs the native toolchain and package regressions plus
the complete compiled language smoke. This ensures a clean runner compiles,
links, and executes a native program through the public CLI. The broader test
suite remains on Ubuntu because its existing LSP fixtures and generated-file
comparisons assume POSIX paths and LF checkouts; those independent portability
gaps do not weaken the native Windows check.

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

The first Actions run found one more cold-run assumption: local development had
already created the parent `vexascript-native` directory, while every clean
runner failed before acquiring the lock because that parent did not exist. The
lock helper now creates only its parent hierarchy before performing the atomic
non-recursive lock-directory creation, and the focused regression starts from a
missing parent.

The next Windows run failed before reaching native validation because the root
`build` script was a chain of POSIX shell utilities and invoked esbuild through
a slash-separated `node_modules/.bin` path. Windows `cmd.exe` consequently
treated `node_modules` as the command name. Distribution assembly now runs in a
tested asynchronous Node script: the esbuild API creates the bundle and Node's
filesystem API replaces `rm`, `cp`, and `chmod`. This keeps one build path for
all hosts instead of teaching the workflow to bypass the package build.

Ubuntu then exposed a separate cross-compiler semantic bug in the native smoke:
GCC evaluated `console.log` arguments in a different order from AppleClang.
That changed a counter before an earlier argument rendered it and deleted weak
collection entries before preceding reads. C++ does not guarantee left-to-right
evaluation of ordinary function arguments. Console lowering now passes its
converted values through a braced initializer list, whose elements are
sequenced left to right, and the runtime consumes that list in order. A small
emitter regression covers the ordering mechanism independently of the large
native smoke.

## Investigation notes

- A local macOS run could validate the Apple path but could not compile the
  Win32 sources or reproduce the GNU/Linux linker behavior.
- A Docker-based MinGW cross-check was considered, but the local Docker daemon
  was not running. Installing a host-wide cross toolchain solely for this check
  would have changed the developer machine more than necessary; the dedicated
  clean Windows Actions runner is the authoritative integration environment.
- Merely adding `windows-latest` while skipping native tests would not validate
  the requested feature. The Windows job therefore builds the repository and
  runs both focused toolchain regressions and the compiled language smoke.
