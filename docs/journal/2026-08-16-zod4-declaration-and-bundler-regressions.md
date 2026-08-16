# Zod 4 declaration and bundler regressions

## Context

Expanding the Zod sample from a single-file Zod 3 smoke test to an unmodified,
multi-file Zod 4.4.3 program exposed failures across the TypeScript parser,
declaration extraction, type aliases, generic constraints, and JavaScript package
bundling. No single Zod API was the root cause; the package combined several
TypeScript constructs that had previously been exercised only in isolation.

## Findings

- TypeScript declaration type parameters may use `const`, `in`, and `out`
  modifiers. Treating those tokens as parameter names corrupted every following
  constraint and return type.
- Re-exported namespace objects must retain overload sets and exported alias names.
  Selecting the first overload made later APIs appear absent, while flattening a
  renamed export made `z.infer` disagree between value, type, hover, and navigation
  paths.
- Object-type text parsers must verify that the closing brace matches the opening
  brace at the end of the complete text. Prefix parsing of
  `{ ... } & { ... }` silently discarded intersections.
- Conditional indexed aliases such as `T["_zod"]["output"]` need the already
  resolved type argument. Converting it back to text loses object shapes and
  imported value provenance, especially across local modules.
- A checked, non-generic exported alias must cross a module boundary as its
  resolved type. Re-evaluating its raw annotation in the consumer loses imports
  that exist only in the declaring module.
- Generic-constraint diagnostics must be conservative when a mapped, qualified,
  or unknown-bearing constraint has not been fully materialized. A false rejection
  of a valid published declaration is worse than deferring a constraint check that
  the current type model cannot prove.
- Zod's enum output crosses several generic wrappers:
  `ToEnum<T> -> Flatten<mapped type> -> $ZodEnumInternals<T> -> T[keyof T] & {}`.
  Resolving mapped aliases before substituting their type parameters produced
  `unknown`; treating `{}` as an intersection identity and resolving wrapped
  mapped types after substitution preserves the published output type.
- `unknown` is also the identity element of an intersection and a valid target
  for every source type. Missing either rule made partially materialized Zod
  option aliases reject valid `{ message: ... }` objects even though their
  remaining mapped property type was deliberately conservative.
- The package bundler misclassified a regular expression whose body began with
  `=` as the `/=` assignment token. The decisive reproduction was
  `.replace(/=/g, "")`; Zod's third chained replacement merely made the tokenizer
  error point at the closing slash and initially obscured the cause.
- The incorrect `unknown` type also made member completion abandon its typed path
  and return global symbols after an expensive recovery. In the real open-editor
  session, `role.` took about 1.44 seconds before the fix. Correct type propagation,
  primitive/literal boxing, and a warmed reusable workspace-export index reduced
  the measured request to about 66 milliseconds while retaining extension
  auto-import suggestions.

## Investigation branches that did not solve the problem

- Downgrading or simplifying the sample would have restored the old green result
  but would not validate the current package contract.
- The first `z.infer` failures looked like mapped-object inference bugs. Instrumented
  type traces showed that several failures occurred earlier: namespace aliases and
  imported `typeof` arguments had already become unknown.
- The regular-expression scanner itself correctly handled escaped slashes and
  character classes. The defect was the contextual decision made before entering
  the scanner, not its termination loop. Additional `*=`, `+=`, `/=`, and `&&=`
  text inside regular-expression bodies confirmed that the bug was specific to
  deciding whether a slash begins a regex, not to any one assignment operator.
- Skipping runtime-class lookup alone did not improve completion: instrumentation
  showed that workspace-wide extension auto-import discovery was the remaining
  cold-path cost. Removing extension suggestions would have hidden that cost but
  regressed functionality; warming and reusing the export index fixed it instead.
- Adding a shared alias abstraction without changing the consumer path left raw
  annotations re-evaluated in the wrong scope. The durable fix was to reuse the
  declaring module's checked top-level type.

## Cold LSP session follow-up

The VS Code timing log exposed a second latency layer: hover, diagnostics, code
actions, and semantic tokens were all waiting on the same 5.7-second analysis
promise. Document version changes re-ran node_modules and ambient declaration
resolution even when imports were unchanged. `AnalysisSessionCache` now shares
both in-flight and completed external resolution across versions with the same
import/export-from surface, while watched-file invalidation still clears it. The
Zod project also declares `types: []` instead of inheriting the repository's
unrelated Node ambient declarations.

The reproduced cold session is about 0.85 seconds. Edit-time completion under a
full VS Code request burst is about 0.35 seconds in isolation and 0.59 seconds
under the full parallel test load; subsequent feature requests take only a few
milliseconds. The regression test uses a one-second ceiling so suite contention
does not make it flaky while the original multi-second failure is still caught.

## Derived-schema type follow-up

The first compatibility pass made the base object and enum schemas usable, but
editor hovers still widened `Role` to `string` and reduced derived schemas such as
`pick`, `partial`, `required`, tuples, unions, records, sets, and intersections to
`unknown`. Two declaration-model gaps combined to produce that result:

- the parser accepted `const` type parameters but discarded the modifier before
  binding function types, so literal arguments widened before generic inference;
- interface method constraints and return types were evaluated with only the
  method's type parameters active, not the enclosing interface parameters. This
  prematurely reduced expressions such as `keyof Shape`, mapped types, and
  `Pick<Shape, ...>` before a concrete schema shape was substituted.

Function types now retain their const-generic parameter names through imported
declarations, cloning, alias expansion, and substitution. Literal-sensitive call
inference consequently preserves string, number, boolean, object, and tuple
literals when the declaration requests const inference. Generic mapped utilities
remain symbolic while they still reference active type parameters and are
materialized after the receiver and method arguments are known.

Schema output recovery remains declaration-driven. It follows structural members
published by the package (`shape`, `element`, `options`, and `_zod.def` tuple or
intersection fields) instead of recognizing Zod class names. This keeps editor
semantics applicable to other libraries exposing the same generic relationships
and avoids a package-specific value catalog.

Several investigation details are worth preserving. Looking only at the final
`z.infer` alias hid the earlier loss of const-generic metadata. Expanding a nested
object argument without reconciling the mapped result restored the entire source
shape for `pick`, which was also wrong. The first word-boundary test used an
accidental backspace escape instead of `\\b`, so it silently failed to recognize
local type parameters. Finally, completion timing alone missed the visible hover
stall; the real multi-file session regression now measures both operations and
separates the cold shared-analysis wait from an immediate warm repeat. Cold hover
and completion requests must stay below four seconds even under the full suite's
parallel load, while every warm probe must finish below 500 milliseconds. This
keeps the test sensitive to the original 5.7-second editor stall without making
its limit depend on unrelated CPU-heavy test files.

The final full-suite run also exposed a narrowing distinction that isolated
object-union tests had missed. `safeParse` returns a union whose branches are
generic named aliases, not inline object types. Discriminant narrowing inspected
only inline `ObjectType` branches, so `if (result.success)` left `result.error`
optional. The narrowing path now expands the union and reads each branch through
the same object-like property resolver used by ordinary member lookup; a focused
generic boolean-discriminant test preserves this behavior independently of Zod.
Only literal-valued properties qualify as discriminants: treating broad status
properties such as React Query's `isLoading: boolean` as exact branch tags caused
valid result data to collapse to `never`.

## Regression strategy

Keep both layers of coverage:

1. focused parser, tokenizer, generic-analysis, and imported-declaration tests that
   preserve the smallest failing TypeScript shapes; and
2. the real multi-file `samples/zod/` program using the published package and
   deterministic runtime output.

For future library compatibility work, build a declaration/API matrix first and
fix the earliest shared compiler or LSP layer. Do not add package-specific editor
catalogs or sample-side declaration shims.
