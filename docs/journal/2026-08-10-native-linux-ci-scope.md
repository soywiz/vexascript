# Keep Linux native CI focused on native behavior

## Change

The Linux native workflow now runs the complete native test index except for
the dedicated native C++ CLI self-compilation test. That self-compilation
cycle is already covered by the isolated `Compiler self-hosting` runner, which
performs the two consecutive native generations needed for its fixed-point
check.

Executable native tests in the Linux job set `VEXA_NATIVE_SINGLE_FILE=1`, so
`cpp link` and `cpp run` emit one C++ translation unit before compiling it.
The normal default remains modular output, and `cpp`/`cpp build` modular-output
coverage remains unchanged. The native link cache records the emission mode so
switching between modular and single-file builds cannot reuse the wrong files.

## Investigation note

The previous native smoke test combined self-compilation with fixture, FFI,
and bundle coverage. Splitting the self-compilation case into its own test
allows Linux CI to retain those independent checks while excluding only the
duplicated self-host cycle.
