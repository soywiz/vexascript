# Inventory Remaining TypeScript Compatibility Gaps

## Status

* [ ] Active

## Context

VexaScript already supports a substantial and useful subset of TypeScript syntax and declaration semantics, including many imported `.d.ts` patterns used by `preact`, `react-query`, `pixi`, `threejs`, `minimist`, `zod`, and `date-fns`.

However, recent ecosystem investigations showed that "TypeScript compatibility" is not one missing feature. The remaining gaps are a long tail of partially supported or still-unsupported patterns that tend to interact:

* advanced type-system constructs,
* higher-order generic inference,
* overloaded and variadic APIs,
* namespace-qualified imported declarations,
* and package declaration-graph edge cases.

Without an explicit inventory, follow-up work keeps getting rediscovered through samples one package at a time.

## Goal

Capture a broad, concrete inventory of the major remaining TypeScript compatibility gaps so future work can be planned intentionally instead of only reacting to whichever package fails next.

## Inventory

The items below are grouped by problem family. They are intentionally broad, but each group should be split into focused implementation tasks.

### Imported declaration graph and module-system gaps

* [ ] Namespace-style exported local bindings such as `export { z }` backed by `import * as z`.
* [ ] Default/namespace/named hybrid export shapes that merge value and type information through reexports.
* [ ] More `export =` compatibility cases when the exported symbol is also merged with a namespace or interface body.
* [ ] Deeper support for `import("pkg").Type` and `typeof import("pkg").value` across imported declaration graphs.
* [ ] Qualified imported type names that traverse nested namespaces or merged declaration/value namespaces.
* [ ] More `typesVersions`, `exports`, and subpath-typing edge cases beyond the package patterns already covered.
* [ ] Better CommonJS/ESM typing interop when runtime default import behavior and declaration export style do not line up cleanly.
* [ ] More robust fallback behavior for packages whose typings live in sidecar files, `@types/`, or multi-step reexport chains.

### Advanced type-system semantic gaps

* [ ] Conditional types beyond the currently supported practical subset.
* [ ] More `infer` extraction forms, especially tuple/rest, nested object, and template-literal positions.
* [ ] More faithful distributive conditional behavior over unions.
* [ ] Recursive conditional or mapped aliases that currently degrade too early.
* [ ] Mapped types over more key spaces and more alias sources.
* [ ] Key remapping patterns whose `as` clause depends on nested conditional or indexed-access logic.
* [ ] Better preservation of optional and readonly modifiers through mapped/intersection-heavy imported aliases.
* [ ] Template literal types whose interpolations stay partially structural instead of collapsing immediately to wide strings.
* [ ] `keyof` and indexed-access behavior over unions, intersections, remapped aliases, and imported qualified types.
* [ ] More partial structural recovery for advanced aliases instead of defaulting straight to `unknown`.

### Higher-order generic inference gaps

* [ ] Curried generic factory patterns where type information must flow across multiple calls.
* [ ] Higher-order APIs where callback parameter and callback return inference feed later generic resolution.
* [ ] Generic defaults that must survive through imported aliases, merged declarations, and higher-order wrappers.
* [ ] APIs that return generic callables or constructables whose later use should preserve the original specifics.
* [ ] More inference from contextual return types when the callee is imported and overload-heavy.
* [ ] Preserving structural information for higher-order utility aliases rather than falling back to `unknown`.

### Variadic, tuple, and overload gaps

* [ ] Variadic tuple inference across imported overload sets.
* [ ] Rest-tuple propagation through helper aliases and curried wrappers.
* [ ] Overload selection for instance methods on imported classes/interfaces when the receiver type is itself imported and generic.
* [ ] Better preservation of imported overload sets on fluent or chained APIs.
* [ ] Operator-like chained library APIs whose intermediate results currently lose type specificity.
* [ ] APIs that use tuple transformations or tuple extraction helpers in public signatures.

### Namespace, merged declaration, and hybrid object-model gaps

* [ ] More merged declaration families beyond the already covered class/interface and function/namespace subsets.
* [ ] Hybrid callable-object and constructable-object APIs whose members live on the function value.
* [ ] Namespace members that should be visible both as type containers and as runtime value objects after import.
* [ ] More robust resolution of members declared through namespace-qualified support types.
* [ ] Deeper support for libraries that model fluent builders or registries as namespace/value hybrids.

### Assignability and structural-compatibility gaps

* [ ] Imported option bags whose structure is preserved in hover/completion but still rejected by assignability.
* [ ] Partial config objects that lose optional-property semantics through imported aliases.
* [ ] Readonly array/tuple/object compatibility in more imported advanced-type combinations.
* [ ] Intersection-heavy imported parameter types that should accept ordinary concrete values.
* [ ] Better compatibility between imported branded-ish aliases and structurally equivalent local values where TypeScript would accept them.
* [ ] Fewer cases where a symbol resolves successfully but later stages still display or validate it as `unknown`.

### Ecosystem-driven gap families to keep probing

* [ ] Observable and operator ecosystems such as `rxjs`.
* [ ] Curried state-factory ecosystems such as `zustand`.
* [ ] Server/router/context ecosystems such as `hono`.
* [ ] Additional state and reactive libraries such as `xstate`, `jotai`, `valtio`, or similar.
* [ ] CLI/config ecosystems with heavily overloaded builder APIs such as `yargs` or `commander`.

## Scope

* [ ] Keep this inventory updated as new libraries reveal new failure modes.
* [ ] Split each problem family into focused executable tasks rather than solving from this inventory document directly.
* [ ] Link the focused tasks back from this inventory so the remaining gap surface stays visible.
* [ ] Avoid marking an item complete merely because one package started passing; close items only when the underlying pattern family is covered.

## Acceptance Criteria

* [ ] The repository has an explicit inventory of major remaining TS compatibility gaps.
* [ ] The highest-value gap families are represented by focused active task documents.
* [ ] New sample-driven failures can be filed against an existing family instead of reopening the taxonomy from scratch.

## Tests

* [ ] No direct runtime tests required for this inventory document.
* [ ] Validate linked tasks and file references stay current.

## Related Tasks

* `docs/tasks/advanced-typescript-type-system-coverage.md`
* `docs/tasks/typescript-utility-type-coverage.md`
* `docs/tasks/imported-type-assignability-for-ecosystem-libraries.md`
* `docs/tasks/ecosystem-stress-samples.md`
* `docs/tasks/imported-namespace-and-qualified-type-interop.md`
* `docs/tasks/higher-order-generic-and-variadic-inference.md`
* `docs/tasks/declaration-graph-edge-cases.md`
