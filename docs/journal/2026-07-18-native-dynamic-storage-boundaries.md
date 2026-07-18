# Native Dynamic Storage Boundaries And Nominal AST Experiment

## Context

The native self-host compiler could be emitted and linked, but its first run on
a minimal source exposed runtime failures that the generated C++ compiler did
not reveal at build time.

## Findings

* Optional calls on dynamic members must preserve call optionality separately
  from optional member access. Calling an absent `options.profile` callback
  showed that emitting `dynamicGet` followed by unconditional `call` loses the
  semantics of `profile?.(...)`.
* A `Value` used by `for-of` cannot be assumed to contain an array. Maps and sets
  need the same canonical dynamic iterable protocol so values retrieved through
  dynamic storage retain their language iteration behavior.
* Conservative dynamic comparisons are safer than choosing a static C++
  operator from a semantic type when the emitted storage type is still
  `vexa::Value`.

## Rejected Prototype-Only AST Experiment

Changing only the shared `Node` interface to a class while leaving concrete
nodes as anonymous objects and retrofitting their prototype in
`Parser.attachNodeBounds` was tested and reverted. It increased parsing from
about 266 ms to 407 ms and pre-emission work from about 9.1 seconds to 10.1
seconds on the 44-module native compiler benchmark. It also produced an
unrepresentable C++ shape: structural AST interfaces would need to extend a
garbage-collected class.

These measurements reject only that partial prototype retrofit. They are not
evidence against a fully nominal AST. Anonymous objects enriched with undeclared
properties remain difficult to map to efficient C++ storage.

## Full Nominal AST Direction

The durable migration converts every concrete AST variant into a real class
with declared fields, typed positional parameter properties, and a shared
metadata base. Parser and compiler transformation sites construct those classes
directly; source-bound attachment never changes an object's prototype. Every
constructor body is deliberately trivial: it only delegates to `super`, and
discriminators are never supplied by callers.

The discriminator is a numeric `const enum NodeKind`, so a concrete constructor
uses `super(NodeKind.ReturnStatement)` and a class narrows `kind` to its enum
member. This preserves discriminated-union narrowing while emitting integer
comparisons. A controlled three-roundtrip JavaScript self-host benchmark used
otherwise identical numeric and string `const enum` variants. The numeric
variant reduced median time from 5.484 seconds to 5.363 seconds, approximately
2.2 percent. The numeric form remains the canonical representation.

A second controlled experiment replaced all 1,300 production
`kind === NodeKind.X` and `kind !== NodeKind.X` checks across 81 files with
nominal `instanceof` checks. Making that comparison valid exposed two remaining
violations of the nominal model. Namespace import isolation changed a
`MemberExpression` into an `Identifier` by mutating its discriminator, while
lowering and declaration merging used object spread to produce objects that had
the right fields but no AST prototype. Namespace isolation now returns a newly
constructed `Identifier`, and lowering, temporary programs, merged namespaces,
and merged interfaces now construct real node classes. A lowering regression
walks the complete result and requires every reachable node to inherit from
`Node`.

After those fixes, both variants passed TypeScript checking and three
byte-stable self-host roundtrips. Ten interleaved runs measured a 4.911-second
median for numeric discriminators and a 4.909-second median for `instanceof`.
The one-sample-trimmed means were 4.922 and 4.979 seconds respectively, making
`instanceof` about 1.1 percent slower by that statistic. The difference is
within run-to-run noise, so there is no Node.js performance reason to replace
the numeric discriminator. The `const enum` remains canonical while nominal
classes remain available where class identity is semantically useful and for
future static C++ lowering.

Optional constructor parameter properties are real own properties initialized
to `undefined`; source metadata fields (`firstToken`, `lastToken`, and
`__vexaNativeSourcePath`) are also initialized on the shared `Node` base. This
gives native lowering a stable declared shape instead of relying on properties
being attached later. Reserved JavaScript property names were replaced by
explicit AST names such as `args`, `isDefault`, `isReadonly`, `isStatic`,
`isConst`, and `isAwait`, allowing the constructors to remain parameter-only.

The final full-suite pass found migration gaps that narrower AST searches had
missed. Two node-module and ambient-default-export paths still accessed the old
`default` field through anonymous structural casts, so default function imports
lost their callable type and declaration origin. They now use the declared
`ExportStatement.isDefault` field directly. A synthetic `BinaryExpression`
created solely to anchor an operator diagnostic also lost its source bounds
when its former initializer bag became positional constructor arguments; it now
copies the operator token into `firstToken` and `lastToken`. Finally, declaration
fixture tests that asserted string discriminator values now assert nominal class
instances. This is evidence that field-renaming migrations must search
compatibility-shaped casts as well as direct property access, and that every
synthetic diagnostic node must preserve explicit source metadata.

The follow-up optimization and Oilpan work remains recorded in
`docs/tasks/accelerate-native-self-host-iterations.md`.

## Regression Coverage

The single native language smoke now executes both absent and present optional
dynamic callbacks, iterates a dynamically stored map, and copies a map retrieved
through dynamic storage. Its output is checked for both JavaScript and native
execution. Parser coverage also walks a mixed program, verifies that every
reachable AST node inherits from `Node`, checks numeric discriminators, and
checks that shared metadata properties exist immediately after construction.
The JavaScript self-host test completes three byte-stable compiler roundtrips
with the nominal numeric AST. Native module execution covers namespace-member
rewriting, which now replaces the member node instead of changing its class in
place. Lowering coverage rejects prototype-losing structural copies.
