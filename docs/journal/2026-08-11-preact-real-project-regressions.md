# Preact Real-Project Sample Regressions

## Context

Expanding the Preact sample from one file into a realistic multi-module project
exercised substantially more infrastructure than the old demo. The project now
uses functional and class components, every Preact hook, core and hook-based
signals, controlled and uncontrolled forms, object/callback/imperative refs,
context providers/consumers, lifecycle methods, and error boundaries.

The sample was intentionally kept free of compensating annotations and casts.
Failures discovered while splitting it were fixed in the compiler and LSP,
then protected by smaller regression tests.

## Root causes and fixes

- Local-module LSP analysis only used the target file's initial analysis. An
  exported value whose inferred type depended on another local import therefore
  degraded to `unknown` in the consumer. Imported declaration collection now
  resolves local imports transitively, analyzes the target with those imports,
  propagates supporting declarations, and guards cycles with the active file
  path set.
- Generic constraints and defaults were resolved without their type-parameter
  scope. Preact signatures such as `K extends keyof S` consequently lost `S`.
  Both maps now resolve while the complete parameter list is active.
- Mapped utility aliases were evaluated before generic substitutions were
  concrete. `Omit`, `Pick`, `Partial`, `Required`, and `WithRequired` now share
  one mapped-object implementation and defer evaluation while an active alias
  still contains an unresolved parameter.
- Preact callback refs allow a cleanup function and are commonly unioned with
  object refs and `null`. Contextual callback selection now ignores non-callable
  union members and accepts repeated structurally equivalent callable members.
- A package-private `type Node` from the signals dependency collided with the
  ambient DOM `Node`. External aliases now retain a separate non-external alias
  source of truth and do not shadow an unimported local or ambient type. The
  same fix preserves callable `Dispatch` aliases when React declarations are
  present through more than one declaration surface.
- Interface inheritance copied parent members over more specific members
  declared by the child. Parent collection now only fills missing members,
  preserving the DOM `Document.getElementById` return type.
- Optional access was only detected through member-expression receivers. A
  chain containing an intervening call, such as
  `ref.current?.getBoundingClientRect().width`, now carries optionality through
  the call callee.
- Imported type usage inside a compound parsed type name such as `Task[]` was
  not counted by unused-import analysis. Nested type references are now scanned
  from non-import syntax before unused bindings are reported.
- Standalone Vite transforms received the private JSX factory names inferred
  from `jsxImportSource`, but only the module-graph bundler injected their
  Preact imports. The page therefore built successfully and then failed at
  runtime with an undefined `__vexaJsxFactory`. Automatic classic-runtime
  binding now lives in `transpile()` itself, so direct Vite transforms and
  module-graph emission use the same implementation and source-map accounting.

## Investigation branches that did not work

- Adding explicit callback parameter annotations made the Preact form compile,
  but only concealed the missing contextual type for JSX component props. A
  duplicate callable union in the expected prop type was the actual cause.
- Treating every external `Node` alias as the DOM type fixed rendering but broke
  aliases used inside their own dependency. Resolution instead had to retain
  declaration provenance and prefer the non-external declaration only outside
  the external declaration that owns the private alias.
- Recursively rebuilding every named and object type during alias expansion
  produced identity churn and exposed infinite recursion in Pixi-style member
  graphs. Expansion now preserves the original named type when its arguments do
  not change, and recursive object-member resolution compares structural type
  identity rather than object identity.
- Testing only the bundled entrypoint missed editor regressions in the new
  modules. Dedicated LSP sessions for the hooks/context, forms/refs, class
  components/signals, shared signal state, and Vite entrypoint now verify
  diagnostics, hover, definitions, and completion against the real packages.
- A successful `vite build` also missed the undefined JSX factory because
  bundling validates symbol syntax, not execution. Loading the production
  transform in a browser and clicking the counter exposed the failure; the
  browser check remains an essential acceptance step for framework samples.

## Lesson

A framework sample is most valuable when it has the same import graph and type
pressure as a real application. Splitting the Preact example exposed bugs that
a single-file showcase could not reach, especially transitive inferred exports
and dependency-private declaration collisions. Keep the broad runnable sample,
but always preserve each discovered failure with a minimal compiler or LSP
regression as well.
