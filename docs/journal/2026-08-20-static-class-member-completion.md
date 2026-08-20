# Static class member completion

## Symptom

In the real Three.js sample, completion after an imported class value such as
`Box3.` offered instance members including `min` and `clone`. A class with no
static members, such as `Vector3`, exposed a second failure: `Vector3.` fell
through to unrelated global suggestions including `true`, `console`, and
`setTimeout`. The same fallback occurred for a constructed instance with no
instance members, such as `Demo().`, when the class only declared static
members.

Invalid instance-member access through the class value also needed to remain
navigable. `Box3.clone` should report that `clone` is not static while go to
definition still resolves the declaration in Three.js's `Box3.d.ts`.

## Root cause

Imported class bindings lost their declaration kind in the binder. They were
represented as ordinary variables even though their imported declaration
provenance pointed to a class. Member completion therefore had no reliable way
to distinguish the class value side from an instance whose type was also
rendered as `Box3`.

After class-value and instance completion were separated, the empty result
still produced global suggestions. The completion orchestrator treated both
`null` and an empty member list as “member completion did not apply.” That
discarded the important distinction between an unrecognized completion
context and a recognized member access with no legal candidates.

An initial isolated declaration-file probe was not representative enough to
expose both problems. Reproducing the request with normal imported declaration
collection, followed by the complete Three.js LSP sample session, showed the
lost symbol kind and the later empty-list fallback independently.

## Fix

The binder now derives imported symbol kinds from declaration provenance, so
an imported class remains a class value. The shared class-member resolver takes
an access kind and filters member collection and resolution consistently:
class values expose static members, instances expose instance members, and
static lookup does not synthesize interface or extension members.

The completion orchestrator now preserves its nullable result contract:
`null` means that another completion strategy may apply, while `[]` is the
final answer for a recognized access with no legal members. This prevents
global fallback for `Vector3.`. Complex value receivers such as `Demo().` are
also recognized even when recovery cannot infer a member, while qualified type
positions such as `z.infer` can still delegate to namespace-type completion.

Semantic analysis reports a dedicated non-static-member diagnostic without
removing declaration resolution. Navigation deliberately continues to use the
unfiltered member resolver, so invalid `Box3.clone` remains useful for go to
definition.

## Validation

Regression tests cover local and imported classes, inherited static members,
instance-side filtering, the empty-static-class case, the non-static
diagnostic, an empty constructed instance, qualified type namespaces, and
cross-file definition navigation. The real Three.js LSP sample
also checks empty completion, the diagnostic, and navigation into
`Box3.d.ts` in one session.
