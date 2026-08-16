# PID-scoped AST caches caused parallel test flakiness

## Symptom

The normal parallel test suite failed nondeterministically in unrelated LSP and
sample tests. Typical failures included missing DOM completions and
`Cannot read properties of undefined (reading 'name')` from interface
resolution. Every reported test passed immediately in isolation, and a
serialized full run passed.

## Investigation

The failures shared runtime declaration programs but did not share a Node test
process. The Node program cache persisted serialized ASTs in temporary files
whose identity was only the process ID. The temporary directory contained more
than eight thousand version-4 cache files spanning the operating system's PID
reuse range.

When a new test worker reused an old PID, it could load a serialized declaration
AST produced by an earlier compiler schema. Numeric node kinds were then revived
with current constructors, so structurally unrelated nodes could satisfy
`instanceof InterfaceStatement` while lacking the current `name` field. Which
test failed depended on which worker PID collided with which stale file.

Running tests serially changed PID allocation enough to hide the problem but did
not fix the cache contract. Retrying individual files was similarly misleading.

## Resolution

Node declaration-program caching is now process-local and uses the existing
in-memory storage. A Node process already retains the module and parsed programs,
so PID-scoped disk persistence provided no useful reuse across process lifetimes.
Browser localStorage caching remains unchanged, and non-Node VFS environments
retain their persistent cache.

The regression test binds a VFS in Node and verifies that repeated cache calls
reuse memory without reading or writing the VFS. Normal parallel full-suite runs
must remain the acceptance check; serialized runs are useful for diagnosis but
must not be used to declare this class of flake fixed.
