# Full-suite regression fixes after tuple-array support

## Context

After adding tuple array suffix support (`[A, B][]`), the focused tests passed
but the full suite still exposed several older regressions across analysis, LSP
and runtime emission. The failures clustered around four shared behaviors:

- readonly index writes emitted the intended readonly diagnostic and then a
  noisy follow-up update-operator diagnostic;
- `override` enforcement could not distinguish imported declarations from
  project-owned declarations;
- imported extension properties needed to outrank shadowed class members across
  analysis, hover, definition, references and signature help;
- extension property emission needed to work both with and without expression
  type metadata.

## Dead ends and evidence

The first `override` attempt treated all ambient/external declarations as
imported and exempt. That fixed node_modules/Preact-style failures, but broke
project-owned ambient/external tests. The useful distinction is not the transport
field (`ambientDeclarations` vs `externalDeclarations`) alone: callers sometimes
use `externalDeclarations` for project files. The durable fix was to keep
external declarations imported by default and add an explicit
`projectOwnedExternalDeclarations` option for project-owned externals.

For the `adler32` sample, changing bitwise operators to return `int` was not
enough initially because the generic `number` arithmetic branch ran first.
Printing the analyzed type of `data[off++] & 0xFF` showed `number & int`, so the
bitwise/shift rule must run before the broader numeric arithmetic rule.

For Matrix4x4 module graph coverage, the test depended on an absolute path
outside the repository (`../runtime/myengine-runtime.vx`). That made the suite
environment-dependent. A local VexaScript fixture inside the test keeps the same
bundle/transpile/runtime coverage without requiring a sibling checkout.

## Guardrails

- Treat `externalDeclarations` as imported unless the caller explicitly marks
  them project-owned.
- For diagnostic cascades, let the first mutability error suppress secondary
  operator/type errors on the same illegal write target.
- Keep extension member precedence consistent across type checking and all LSP
  surfaces; if the type checker chooses an imported extension member, hover,
  definition, references and signature help should agree.
- Keep module graph tests hermetic; avoid absolute fixture paths outside the
  repository.
