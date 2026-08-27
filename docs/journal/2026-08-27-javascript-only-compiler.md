# JavaScript-only compiler cleanup

## What changed

VexaScript now has one code-generation target: JavaScript. The secondary
source-generation backend, its runtime, build adapters, command-line commands,
configuration, fixtures, samples, CI jobs, and current reference documentation
were removed as a single subtractive change.

JavaScript FFI remains supported. Foreign-library declarations, ABI-aware
struct layouts, pointers, buffers, and the Deno sample continue to use the
shared parser, analyzer, and JavaScript emitter. Backend-only annotations and
AST metadata were removed instead of being retained as compatibility shims.

Compiler self-hosting also remains supported, but it now validates only the
JavaScript fixed point. The CI driver performs two generated-compiler
roundtrips and requires byte-identical output.

## Investigation and cleanup boundary

The first repository-wide audit found that deleting tracked source files was
not sufficient. Old generated executables, object caches, and build directories
were untracked and therefore survived the source deletion. A second filesystem
audit removed those artifacts explicitly.

The cleanup deliberately retained terminology such as foreign library and
native memory where it describes JavaScript FFI behavior. Those concepts are
part of the supported JavaScript runtime contract and are independent of a
compiler output target.

Historical blog posts and engineering journals remain in the repository as an
archive of earlier implementation stages. Their descriptions are intentionally
historical and do not define the compiler's current supported targets.

## Regression prevention

Keep transpilation and CLI build options JavaScript-only. New runtime
interoperability should extend the existing JavaScript FFI model rather than
introducing another emitter, target-specific AST fields, or parallel module
graphs. Repository audits for removed target names should exclude third-party
declaration fixtures and installed dependencies while still scanning source,
tests, documentation, CI, and generated artifacts.

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: OpenAI
