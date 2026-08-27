# Native C++ workflows now share the `cpp` command group

The CLI previously exposed native C++ behavior through separate `cpp`,
`executable`, and `native` commands, while `build` also carried `--emit cpp`
and `--native` switches. That made the public help describe several spellings
for the same native pipeline and made it easy for the workflows to diverge.

The native interface is now unified as `cpp`, `cpp build`, `cpp link`, and
`cpp run`. The direct `cpp <input>` form is the short compile form. The command
parser now supports nested commands and nested `help` paths, so the CLI and the
website can document each native operation from the same hierarchy.

`cpp link` and `cpp run` persist the generated C++ path, watched source mtimes,
compiler version, compiler options, and native compiler flags in the build
directory. An unchanged graph reuses the C++ translation unit, and an
executable newer than that translation unit is reused without invoking `g++`.
The cache includes project `vexascript.json` and `tsconfig.json` files when
present so configuration changes invalidate the native artifacts.

During validation, the first full parallel test run showed five unrelated DOM
navigation failures while the CLI and native tests passed. The same
`crossFileNavigation.test.ts` file passed all 92 tests when run in isolation,
which points to an existing shared DOM declaration/cache race under full test
parallelism rather than a command-group regression. The final full-suite run
was repeated after the native command checks and passed all 2,399 tests, so
the command-group change has no observed regression in the current suite.
