# Abstract-class member conformance (parity with interface conformance)

## What changed

A concrete class extending an abstract class now reports each inherited abstract
member it leaves unimplemented:

```
abstract class Test(val ms: number) { abstract fun demo() }
class Demo extends Test {}   // error MYL2024: Non-abstract class 'Demo' does not
                            // implement inherited abstract member 'demo' from class 'Test'
```

New analysis issue code `ABSTRACT_MEMBER_NOT_IMPLEMENTED` (LSP `MYL2024`),
emitted by `TypeChecker.validateAbstractMemberImplementations`, one diagnostic
per missing member on the subclass name node, carrying
`data: { className, baseClassName, memberName }`.

## Reused the interface quick fix path

Interfaces already had the whole pipeline: `validateImplementedInterfaces`
emitted `IMPLEMENTS_MISSING_MEMBER`, and `interfaceImplementationFixes.ts`
turned it into an "Implement missing member" code action by resolving the
member signature with `resolveClassMember`. That resolver already walks the
`extends` chain and returns the signature of bodyless members (interface
methods *and* abstract class methods alike), so the abstract case needed no new
stub-generation logic — only that `parseImplementsDiagnostic` also accept the
new code/message and map it to the existing `missing` branch (with the base
class name carried in the unused `interfaceName` slot). This is the unification
the project prefers: one stub-generation route for both supertype kinds.

## The trap: existence != implementation

The obvious shortcut — "is the member present on the concrete class type?" via
`resolveNamedTypeMembers(classType)` — does NOT work for abstract detection,
because that map already includes members *inherited* from the abstract base,
including the abstract declarations themselves. A missing abstract method still
shows up as "present". So the check must walk the AST `extends` chain and look
at the `abstract` flag directly: collect abstract obligations from ancestors and
the set of concretely-provided names (own non-abstract members, primary
constructor properties, and class-delegate members), then subtract.

## False-positive guards

- Only concrete (`abstract !== true`, `declared !== true`) classes are checked.
- Obligations are skipped for `declared` (ambient) ancestors, so extending an
  ambient abstract base from a `.d.ts` does not spuriously fire.
- When `extends` resolves to an interface (not in `classStatementsByName`), the
  abstract check bails and interface conformance handles it — no double report.

Full suite stayed green, including the `abstract class Component<P,S>` React
typings tests, which is the case to watch if this logic is touched again.

## Possible follow-up

Both the interface and abstract flows emit one diagnostic (and one quick fix)
per missing member. A single aggregate "Implement all missing members" action
would be a nice addition and would benefit both supertype kinds through the same
shared path.

## Addendum: `override` against interfaces + signature quick fix

Two follow-up bugs surfaced from the same screenshot:

1. `validateOverrideMembers` only looked at the base **class** chain, so
   `override fun lol2()` for a member declared in an *implemented interface*
   wrongly reported "cannot override because no member with that name exists in
   base type 'Test'". Fixed by also gathering interface member names (via the
   existing `implementedInterfaceTypesForClass`) as valid override targets.
   Signature checking for interface members is left to
   `validateImplementedInterfaces` so the two passes don't double-report.

2. An `override` whose signature didn't match the base member was reported
   (`Member 'm' override type ... does not match base type ...`) but had **no**
   quick fix, unlike the interface incompatible-member case. Gave that
   diagnostic a code (`OVERRIDE_INCOMPATIBLE_MEMBER` / `MYL2025`) plus
   `data: { className, baseClassName, memberName, expectedType }`, and taught
   `interfaceImplementationFixes.ts` to treat it as an `incompatible` result
   (with `supertypeKind: "class"` so the action title reads "...to match base
   class 'B'"). The signature-rewrite logic itself was already generic and
   reused unchanged.

Same lesson as the parent entry: the interface path had the richer behavior
(both missing *and* incompatible, each with a quick fix) and the
class/override path lagged behind. When one supertype kind grows a check, the
other usually needs the parallel one — keep them converging on the shared
diagnostic+fix shape rather than letting them drift.

`override` is purely a type-level modifier and is already erased by the emitter
(`emitClassMember` builds the member from its name and never emits the
modifier); locked with an emitter test.

## Addendum 2: abstract signature mismatch *without* `override` (+ the preact trap)

Abstract conformance was name-based only, so a method implementing an abstract
member with the **wrong signature and no `override`** (e.g. `demo()` for
`abstract fun demo(a: int)`) slipped through entirely — `validateOverrideMembers`
only checks members carrying `override`, and the name matched. Added a signature
check to `validateAbstractMemberImplementations` (new code
`ABSTRACT_MEMBER_SIGNATURE_MISMATCH` / `MYL2026`) that runs only for own members
**without** `override` (override members stay owned by `validateOverrideMembers`,
so no double report), reusing the same signature-fix quick fix as the override
case.

The trap: the first cut compared signatures with `isSameType` (strict equality),
exactly like the override check. That immediately broke the `preact` sample —
`class Clock extends Component` implements `render()` while the abstract
`Component.render(props?, state?, context?)` declares three **optional**
parameters. Strict equality flagged it as a mismatch even though omitting
trailing optionals is a perfectly valid implementation.

`isTypeAssignable` is the opposite problem: this codebase's function
assignability treats a zero-param function as assignable to a many-param type
(standard subtyping), so it flags *nothing* — not even `demo()` vs
`demo(a: int)`. Verified by probing interface conformance: `class C implements I`
with `say()` against `say(a: number)` produces no diagnostic.

The resolution is neither: the real rule the user wants is "the implementation
must declare a slot for every **required** parameter of the abstract member".
`abstractMemberSignatureMismatches` flags when
`ownParams.length < requiredAbstractParams` (required = not optional, not rest).
That flags `demo()` vs `demo(a: int)` (1 required dropped) and accepts `render()`
vs `render(props?, state?, context?)` (0 required). Param *type* mismatches of
declared params are intentionally not checked yet — that's where the complex
union types in framework typings make `isSameType` dangerous; revisit only with
a comparison that tolerates equivalent-but-not-identical type spellings.

Lesson for next time: before using `isSameType`/`isTypeAssignable` for any
member-conformance check, test it against the `preact` sample's `Component`
subclassing — its optional-parameter `render` is the canonical case that breaks
naive equality.

## Addendum 3: mandatory `override` — scoping was the whole problem

Made `override` **required**: a member redefining a project supertype member
without it is reported (`MISSING_OVERRIDE_MODIFIER` / `MYL2027`) with an
"Add 'override'" quick fix (`overrideModifierFixes.ts`). Implementing the rule
was trivial; *scoping* it correctly was the entire task. A naive "any supertype
member" rule broke 15 tests, almost all legitimate TypeScript-interop patterns.

Two false signals that did NOT work for "is this a project type":

- **`declared`**: unreliable. node_modules `.d.ts` files routinely use
  `export class X` (no `declare`), so `declared` is false on them. Scoping by
  `declared` still flagged every node_modules base class.
- **`externalNamedTypeNames` / external-vs-non-external**: also wrong, because
  imported *project* `.vx` files and imported *node_modules* `.d.ts` both arrive
  as `externalDeclarations`. There is no field that distinguishes "imported from
  my project" from "imported from node_modules" at the TypeChecker level.

What worked: a `programDeclaredTypeNodes` WeakSet of the analyzed file's own
class/interface statement nodes (walked from `program.body` in the constructor).
The rule only fires when the overridden member comes from a type declared **in
the same file**. This is a deliberate under-enforcement (cross-file project
types are spared) but it is the only signal that is reliably "the user's own
code" and never node_modules. Plus a `language` flag threaded through
`AnalysisOptions` → `TypeChecker` (defaulting `vexascript`, set to `typescript`
from the parser language in `compileSource`) so TypeScript-mode files are exempt,
matching the user's "`.vx` only" decision.

The user explicitly chose this scope (`.vx` project types only) over
"everywhere" via a clarifying question — worth asking, because the broad version
silently rewrites valid TS-interop code.

## Addendum 4: surplus `extends`/`implements` and a parser trap

`class X extends A extends B` / `... implements I implements J` used to emit a
confusing `Expected ';'` *parse* error with no fix. Now the parser accepts any
number of `extends`/`implements` clauses (storing surplus ones in
`extraExtendsTypes` / `extraImplementsTypes`) and `validateHeritageClauses`
reports a clean semantic error per surplus clause.

The trap: `extends A extends B` parsed the heritage type with
`parseTypeAnnotationNode`, which greedily reads the second `extends` as a
**conditional type** (`A extends B ? … : …`) and then fails expecting `?`.
`implements` didn't hit this because only `extends` triggers conditional-type
parsing. Fix: parse heritage operands with a dedicated `parseHeritageTypeNode`
that stops at the union level (`parseUnionTypeAnnotationText`), never consuming a
trailing `extends`.

Generated stubs now use `throw Error("Not implemented")` (no `new`) — the
VexaScript idiom, since calling a class without `new` is lowered to `new` by the
emitter.
