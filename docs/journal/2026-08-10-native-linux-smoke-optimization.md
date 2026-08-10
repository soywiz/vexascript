# Native Linux smoke optimization and dependency toolchains

The Linux native smoke job uses Clang first because GCC has already failed
with optimized generated executables. The smoke tests are semantic/runtime
coverage, not optimizer coverage, so the executable links now pass `-O0`
explicitly. The deterministic sample matrix already followed this policy;
module, project, complete-sample, FFI, installed-package, and Oilpan-cycle
smokes now do too.

Native dependency archives must use the same primary toolchain as the
executable. Oilpan is compiled with the selected C++ compiler and mimalloc
with its matching C compiler (`clang` for `clang++`, `gcc` for `g++`). Cache
artifact names include the compiler so a GCC-built archive cannot silently be
reused by a Clang build. The native self-hosted adapter follows the same
layout.

The self-hosting CI job also caches `~/.vexascript/native`, keyed by runner
platform, architecture, the Clang version, and the vendored Oilpan/mimalloc
archives. This avoids rebuilding those dependencies on every isolated runner
while still invalidating the cache when the ABI-relevant inputs change.

A local self-host timing separated the costs: C++ generation took about five
seconds per pass, first-time Oilpan/mimalloc setup about ten seconds, and the
native self-host stage about 236 seconds. The latter is the dominant cost and
comes from compiling and linking the large single-file C++ host; dependency
caching will remove repeated setup but will not by itself solve that compiler
cost.
