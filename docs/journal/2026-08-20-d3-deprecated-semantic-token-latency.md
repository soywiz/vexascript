# D3 deprecated semantic-token latency

## Symptom

Editing a single D3 attribute expression in `samples/d3/html.vx` made the VS
Code extension host pause for more than five seconds. The LSP timing log showed
that token construction took only 13.7 ms, while
`deprecatedSemanticTokenModifiers::collect` took 5,531.2 ms and the complete
semantic-token request took 6,125.5 ms. Completion and signature help were also
reported at 1,085.0 ms and 1,632.8 ms during the same editor burst.

The timing distribution localized the blocking work, but elapsed time alone was
not a stable regression invariant because concurrent CPU work can inflate every
request waiting on the LSP event loop.

## Investigation

The deprecated-member pass resolved every member expression before learning
that the D3 document contained no deprecated member use. A clean in-process D3
profile observed 54 member expressions and 26 project-session requests from
this inverted search.

Several investigation paths exposed tooling and model problems:

- The checked-in profiler failed under bare `pnpm tsx` because compiler modules
  import `.vx` runtime declarations. It now runs through Node with both the TSX
  hook and `scripts/registerTextModuleLoader.cjs`.
- The profiler still populated the removed `importedSymbolTypes` and
  `importedSymbolDisplayTypes` session fields. That produced 30 diagnostics and
  misleadingly fast timings because it did not reproduce the production
  declaration graph. It now uses `importedSymbols`, declaration provenance, and
  the current `AnalysisSessionCache` external resolver contract.
- Filtering only by globally deprecated member names reduced the 26 project
  requests to 12, but names such as `domain`, inline-object `value`, and DOM
  `querySelector` still collided with unrelated deprecated declarations.
- An owner-aware filter removed the false name collisions. Recording whether an
  owner is a class or interface also avoided trying the impossible resolver
  branch. `Document.querySelector` remains one legitimate candidate because the
  DOM declarations contain a deprecated overload; the authoritative resolver
  correctly decides that the D3 call itself is not deprecated.

## Fix

Deprecated semantic-token collection now builds a cached declaration index
before resolving member uses. The index records declared owners, declaration
kind, inheritance edges, and deprecated members. Each member expression is
cheaply rejected unless its receiver owner, ancestry, and member name can reach
a deprecated declaration. Only genuine candidates enter the existing
class/interface member resolver, so overload-specific behavior remains the
source of truth.

The owning subsystem exposes deterministic counters for collections,
declaration roots and nodes, member visits, candidates, unique resolutions, and
resolution-cache hits. The LSP timing log emits request-local deltas alongside
the observational timings.

## Results

The clean D3 profile after the fix reports:

- cold deprecated pass: 54 member visits, one genuine candidate, one local
  resolution, and zero project-session requests;
- immediate warm pass: every one of 2,764 declaration roots is a cache hit and
  zero declaration nodes are revisited;
- first pass after an edit: 2,763 declaration-root cache hits, only the edited
  document's 407 nodes revisited, one candidate, one resolution, and zero
  project-session requests;
- token construction: about 4 ms in the observed run;
- edited session: one base build and one resolved build, with one external-cache
  hit and zero external-resolver runs.

Observed local elapsed times were about 28.6 ms cold, 6.0 ms warm, and 4.2 ms
after an edit for deprecated modifiers. These numbers document the reproduction
but are not test thresholds. The durable invariant is that a non-deprecated D3
edit performs zero project-session requests in this pass.

## Regression protection

Focused tests cover inherited interface deprecation, reuse for repeated member
expressions, zero resolution work when no accessible declaration can deprecate
the member, declaration-index reuse, the ordinary edit path through the LSP,
and the emitted work-counter timing line.

The compiler/LSP optimization and infrastructure-debugging skills now require
the cold/warm/edit split, valid diagnostics before trusting a profile, the
current session contract, and candidate-first inverted search when most uses
cannot match an expensive semantic condition.

## Follow-up: incomplete member chains

After the deprecated semantic-token fix, inserting a standalone `.x` before the
D3 line generator's existing `.x((reading) => ...)` call still paused the editor.
The new timing owner was `workspaceMemberDiagnostics::collect`: 1,125.2 ms on
the first pull and 10.8 ms when repeated.

The exact edit scenario showed that the cross-file member fallback was acting
as a second semantic pass. Of 55 member expressions, 51 already had a resolved
semantic type. The incomplete chain also contained one member whose receiver
was a known function, two callback properties whose receivers had become
unknown after contextual typing was broken, and one later chain operation whose
receiver remained unknown only because of the earlier function receiver.

The collector now skips those impossible fallback candidates before resolving
an expression type or class. It retains the fallback for genuinely unresolved
named and array receivers, including chained members of imported project
classes. New counters cover semantic-analysis skips, unsupported direct and
chained receivers, unknown receivers, object-type resolution, class/member and
extension resolution, and emitted diagnostics.

In the maintained `d3 incomplete-member` profile, the edited workspace-member
pass now performs zero project-session requests, zero class resolutions, and
zero member/extension resolutions. Its observed duration fell to about 0.17 ms.
The profiler keeps this edit scenario so future regressions exercise the
temporary invalid state that occurs while typing, not only valid saved source.
