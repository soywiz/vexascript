# Call-context navigation targets

## Symptom

Editor navigation treated every identifier-shaped token as an ordinary symbol
reference. A named argument such as `width:` had no hover or definition, while
`ArrayBuffer(4)` navigated to the ambient `var ArrayBuffer` declaration instead
of the `new (byteLength: number): ArrayBuffer` signature that the call actually
selected.

## Root cause

The general symbol resolver knew the declaration identity of `ArrayBuffer`, but
not the syntactic role of the cursor inside a particular call. Named-argument
completion already resolved callable parameter names, yet hover and definition
did not map the argument label back through the callee. Constructor signature
help likewise knew that callable constructor variables select a `new` member,
but ordinary navigation discarded that call context.

## Durable rule

Resolve call-specific targets before ordinary identifier fallbacks. Named
arguments first resolve the callee through the canonical definition pipeline,
then locate the homonymous parameter in that declaration's AST. Constructor-
style calls reuse constructor-signature selection and navigate to the matching
`new` member, falling back to the class declaration when there is no explicit
constructor node. Hover and definition consume the same resolved target so
they cannot disagree about which declaration the call selected.

The initial implementation placed all of this logic directly in
`crossFileNavigation.ts`. Although functional, it made the orchestration module
substantially larger and obscured the shared call model. Moving it into
`callNavigation.ts` kept the public hover/definition ordering explicit while
leaving call-target discovery in one browser-compatible module.

The first real-browser hover check still displayed `expression: int`. Repeated
cursor-position experiments initially suggested an inlay-hint coordinate
problem, but hovering the declaration proved that Monaco was delivering token
positions correctly. Inspection of the worker request handler showed the real
cause: Monaco called `resolveMemberHoverAcrossFiles` and then `createHover`
directly, bypassing `resolveHoverWithLocalFallback`. Routing the worker through
the unified entrypoint fixed the browser surface and removed another parallel
hover cascade.
