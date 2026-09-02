# Question Kingdom compiler and LSP work caches

## Symptom

Question Kingdom made several kinds of repeated work visible at realistic
project scale. A cold bundle took about 7.3 seconds, a second incremental bundle
still took about 2.6 seconds, and the first full LSP open burst took about 11
seconds. The runtime bundle contained 810 watched JavaScript modules, but that
number was not the LSP workload: 54 local VexaScript modules and the declaration
graphs selected for their package imports were the semantic workload. The
remaining watched files were transitive PixiJS and Box2D runtime dependencies.

Wall-clock measurements were useful for locating the expensive paths but were
not suitable as regression assertions. Test contention and filesystem caches
changed elapsed time while the compiler performed the same amount of work.

## Reusable work boundaries

The module graph now keeps compiled module results next to its existing
incremental type contexts. An entry-only rebuild can reuse unchanged analyses,
emitted code, warnings, errors, and diagnostics. A dependency change still
invalidates the graph-wide contexts because it can alter downstream typing.
The ambient emitter environment is built once and extended with each module's
external declarations instead of rebuilding the ECMAScript and DOM seed for
every module.

Package import resolution has two scopes of reuse. A bundle-local cache shares
identical package-import resolutions between local modules, and the selective
declaration cache accumulates the names already requested from each resolved
typings entrypoint. A later request covered by that accumulated set can reuse
the declaration result. The cache remains keyed by the resolved typings file
and its modification time, and cache clearing invalidates exact and accumulated
entries together.

Node ambient declarations are no longer loaded for every browser package. They
are loaded immediately for `node:` imports and otherwise only as a fallback
when package binding resolution remains invalid. Runtime dependency discovery
also overlaps independent file reads, stats, import resolutions, and graph
branches, then assigns module identifiers in a deterministic emission pass so
parallel discovery does not change bundle output.

The LSP had a separate duplication boundary. Recursive local-import collection
could construct the same resolved `Analysis` repeatedly through diamond-shaped
graphs. A collection-scoped promise cache now shares that analysis. Open
document indexing also stores the source text, reuses identical completed
sessions, and shares an in-flight build when editor events request the same
source concurrently.

## Deterministic regression evidence

Question Kingdom tests now bound work rather than time. A cold compilation may
analyze and emit at most 55 local modules, resolve at most 24 distinct package
import signatures, build at most 12 selective typings supersets, and must record
both package-resolution and superset cache hits. The LSP session bounds open
session builds, disk session builds, local analysis builds, project session
requests, and selective typings builds. The all-samples LSP harness measures
each sample from its own project root and reports a delta from the start of that
session so cached metrics from unrelated samples cannot contaminate its
baseline.

The final isolated measurements were approximately 5.49 seconds for a cold
bundle, 0.08 seconds for the second incremental bundle, 5.29 seconds for the
first LSP open burst, 2.33 seconds for a second session with a warm project
index, and 0.65 seconds for PlayerController. These measurements describe the
observed effect; the counters are the enforced contract.

## Investigation branches ruled out

Pruning DOM declarations by scanning identifiers looked attractive because the
compiler visited 2,494 ambient declarations for each of 54 local modules. The
prototype produced many false diagnostics: declaration maps, aliases, and
indirect dependencies require symbols that are not mentioned directly in the
source. It was removed rather than weakening type coverage. A safe version
would need a dependency-closed ambient index, not textual filtering.

Parallel runtime dependency discovery was retained because it removes serial
I/O without changing graph order, but it did not materially reduce the cold
Question Kingdom time by itself. Profiling showed that selective package
declaration collection, not JavaScript file discovery, dominated that part of
the build. Likewise, the 810 runtime modules cannot be reduced safely by
following only named imports: package barrels and side-effect registration make
that a tree-shaking problem requiring explicit package side-effect semantics.

The accumulated typings cache was tested A/B under the same warm filesystem
conditions. Without it, three cold processes took roughly 6.76--6.85 seconds;
with it, three equivalent processes took roughly 5.49--5.51 seconds with the
same 54 analyzed modules and no diagnostics. This evidence justified keeping
the optimization and adding direct counter coverage.

## Validation

- Focused compiler, package-typing, module-graph, LSP, and sample tests passed.
- The complete suite passed 2,949 tests with no failures.
- JavaScript self-hosting reached a byte-identical fixed point.
- The Question Kingdom Vite production build transformed 876 modules and
  completed successfully.

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: OpenAI
