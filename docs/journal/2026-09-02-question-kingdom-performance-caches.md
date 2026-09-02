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

Auto-import discovery now has a deliberately narrower boundary than semantic
typing. It reads declarations exposed by the package entrypoint and follows
only public re-export edges. Ordinary imports and triple-slash references are
not auto-import candidates merely because they support a public declaration.
Forwarded bindings such as `import type { X } from "./x"; export { X };` are
treated as public edges, so their type-only status and declaration kind remain
correct without exposing unrelated declarations from `./x`.

Semantic typing still follows the transitive declaration closure required by
the selected imports. A per-file declaration index now shares each parsed AST,
its direct declarations, support specifiers, and resolved declaration edges
between growing selective-typings requests. This cache is intentionally not a
whole-subtree result cache: subtree results depend on the active cycle guard,
whereas per-file facts do not. The distinction preserves cyclic declaration
graphs while eliminating repeated stats, reads, parses, and edge resolution.

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
both package-resolution and superset cache hits. Declaration work is additionally
bounded to at most 730 file-index builds and 2,652 distinct edge resolutions,
and the tests require file-index cache hits. The LSP session bounds open session
builds, disk session builds, local analysis builds, project session requests,
selective typings builds, and the same declaration-index work. The all-samples
LSP harness measures each sample from its own project root and reports a delta
from the start of that session so cached metrics from unrelated samples cannot
contaminate its baseline.

After the declaration-index change, three isolated cold bundles took
approximately 4.00--4.02 seconds, down from 5.49--5.51 seconds. The first LSP
open burst took about 3.54 seconds, down from 5.29 seconds; a second session with
a warm project index remained about 2.30 seconds, and PlayerController about
0.69 seconds. Package auto-import discovery for the `Con` prefix took about
0.66 seconds cold and 0.004 seconds warm, down from about 0.86 seconds cold,
while returning the same 11 candidates. These measurements describe the
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

PixiJS also explains why declaration discovery cannot become proportional only
to the handful of imported names without additional metadata. Its root typings
use nested `export *` barrels: finding which branch owns a name requires reading
the public export graph at least once. In the pinned Question Kingdom dependency
set, that graph contains 647 PixiJS declaration files and 43 Box2D declaration
files. Avoiding that first-process scan would require a persistent public-symbol
index keyed by package contents or lockfile state. Such an index is viable, but
it is a separate invalidation and storage feature; blindly skipping export-star
branches would make valid imports disappear.

The accumulated typings cache was tested A/B under the same warm filesystem
conditions. Without it, three cold processes took roughly 6.76--6.85 seconds;
with it, three equivalent processes took roughly 5.49--5.51 seconds with the
same 54 analyzed modules and no diagnostics. This evidence justified keeping
the optimization and adding direct counter coverage.

## Validation

- Focused compiler, package-typing, module-graph, LSP, and sample tests passed.
- The complete suite passed 2,951 tests with no failures.
- JavaScript self-hosting reached a byte-identical fixed point.
- The Question Kingdom Vite production build transformed 876 modules and
  completed successfully.

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: OpenAI
