# Deno run mode and executable FFI samples

The JavaScript FFI backend already emitted `Deno.dlopen`, but the CLI had no
way to compile a VexaScript file and hand it to Deno. The new `vexa run -deno`
path writes a temporary module and invokes `deno run -A`, then removes the
temporary file asynchronously. The focused CLI regression test checks both
the complete permission flag and cleanup.

The SDL2 dynamic sample is now directly executable. A shebang using plain
`/usr/bin/env vexa run -deno` is not reliable when multiple arguments must be
passed through the POSIX interpreter line, so the sample uses the common
`env -S` form instead: `#!/usr/bin/env -S vexa run -deno`.
