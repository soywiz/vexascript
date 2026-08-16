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

## Regression strategy

Keep both layers of coverage:

1. focused parser, tokenizer, generic-analysis, and imported-declaration tests that
   preserve the smallest failing TypeScript shapes; and
2. the real multi-file `samples/zod/` program using the published package and
   deterministic runtime output.

For future library compatibility work, build a declaration/API matrix first and
fix the earliest shared compiler or LSP layer. Do not add package-specific editor
catalogs or sample-side declaration shims.
