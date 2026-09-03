# Cross-module class types and Vite semantics

## Problem

A platformer project exposed several related gaps in project-aware analysis.
An aliased local class import could be constructed, but using it as a base
class lost inherited members. An exported class field initialized from a typed
constructor parameter became `unknown` in consuming modules when the field had
no explicit annotation. Separately, the Vite plugin resolved imports but passed
`typeCheck: false` to the transpiler, so ordinary Vite builds could succeed
while the CLI and editor reported semantic errors. Enabling that check exposed
two more issues: the transform discarded imported-declaration provenance, and
its long-lived cache could publish a context-partial result produced while
walking a cyclic import graph.

## Investigation

Imported declarations were already present in the consumer analysis, so
duplicating declaration collection was not the answer. The alias failure came
from resolving the textual local name in the `extends` clause instead of the
canonical named type stored on its imported binding. The inferred-field failure
was narrower: external class declarations have no bound class scope, even when
the initializer simply refers to a constructor parameter whose annotation is
still present in the AST.

Adding explicit annotations in the consuming project made the symptoms
disappear but only moved compiler responsibilities into application code. A
separate pre-build CLI type-check also caught errors, but it left the official
Vite transform semantically incomplete and duplicated work.

The provenance omission allowed a package declaration and a project class with
the same name to collapse during semantic lookup. The cache problem was
order-dependent: a module first reached recursively inside a cycle was cached
globally even though ancestors intentionally had not been expanded. A later
top-level transform then reused that incomplete declaration closure and lost
otherwise valid inherited members.

## Change

Loose named-type normalization now follows imported bindings to their canonical
nominal type before inheritance and member lookup. External class-field member
resolution now reuses typed primary or traditional constructor parameters when
an unannotated field directly initializes from that parameter. The Vite plugin
enables semantic type checking, forwards imported-declaration locations, and
reports semantic warnings through Vite's warning context. Imported-declaration
collection now records which ancestors were omitted to break a cycle. As each
ancestor walk completes, its declaration closure is merged back into partial
descendants; a cache lookup still rejects a partial result when its missing
ancestor is not part of the current traversal. This preserves the shared cache
and its bounded LSP work while preventing order-dependent truncation.

## Regression risk

Alias canonicalization is restricted to imported bindings whose resolved named
type exists in the declaration registry, avoiding unrelated value-name
rewrites. Constructor-backed inference only handles direct identifier
initializers; more complex inferred public expressions will require carrying a
shared analyzed declaration shape rather than expanding this rule case by case.
Regressions cover aliased inheritance, constructor-backed fields across three
local modules, Vite semantic errors, Vite missing-`override` warnings,
project/package name collisions, and cache reuse after cyclic traversal.

## Execution metadata

- Date: 2026-09-03
- Provider: OpenAI
- Model: Unavailable (not exposed by runtime)
