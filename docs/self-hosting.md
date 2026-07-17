# Compiler Self-Hosting

VexaScript can transpile and bundle its own TypeScript compiler, execute that
generated JavaScript compiler, and repeat the process until the emitted bundle
reaches a byte-stable fixed point.

Run the checked-in three-roundtrip workflow with:

```sh
pnpm self-host
```

An optional first argument selects the output directory:

```sh
pnpm self-host /tmp/vexa-self-host
```

The command emits `vexa-self-host-1.js` through `vexa-self-host-3.js`, verifies
that all three files are byte-identical, executes the last compiler's version
path, and prints the common SHA-256 digest. The automated regression in
`cli/selfHost.test.ts` additionally uses the third compiler to bundle and run a
normal VexaScript fixture.

## Bootstrap Contract

The first compiler is built by the source CLI. Every later compiler is built
by the JavaScript compiler from the preceding roundtrip, from an isolated
working directory so the development-only source CLI delegation cannot hide a
self-hosting failure.

The compiler entrypoint is bundled with:

```sh
vexa bundle cli/cli-bin.ts --transpile-only --platform node
```

`--transpile-only` still parses and analyzes every TypeScript source file so
the emitter receives its normal metadata. It only prevents VexaScript semantic
diagnostics from blocking JavaScript emission. This is appropriate for the
compiler sources because `tsc --noEmit` remains their authoritative type check.

`--platform node` emits the `createRequire` bridge used for genuine Node
builtins and external dependencies. Browser bundles remain the default and do
not acquire Node runtime dependencies.

The module graph also honors `compilerOptions.baseUrl` from the nearest
`tsconfig.json`. This is how imports such as `compiler/vfs` resolve through the
same local graph as relative imports instead of leaking into runtime package
resolution.

## Fixed-Point Requirement

A successful first execution is not sufficient. The checked-in workflow
requires three identical generations:

1. source compiler produces compiler 1;
2. compiler 1 produces compiler 2;
3. compiler 2 produces compiler 3;
4. compiler 3 compiles and runs an ordinary fixture in the automated test.

Byte equality catches nondeterministic graph traversal and emitter drift in
addition to syntax or runtime failures.
