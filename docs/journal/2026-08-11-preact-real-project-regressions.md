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
- Transitive import analysis propagated supporting declaration AST nodes but
  not their source files. Hover could therefore know that `visibleTasks.value`
  was `Task[]`, while Go to Definition fell through to local navigation and
  paired the external `ReadonlySignal.value` range with `hooks.vx`. VS Code
  clamped that impossible range to the end of the consumer file. External
  declarations now carry one shared location map through collection, recursive
  imports, analysis sessions, completion recovery, and type-member navigation.
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
- The TextMate rule for self-closing JSX required `/>` on the same line as the
  opening tag. A multiline `<input ... />` therefore entered the paired-element
  rule, whose closing pattern accepted the parent `</label>`. The parent scope
  remained open and later declarations such as `export func FilterControls`
  were parsed as unhighlighted JSX text. Paired elements now close either at a
  multiline `/>` or at the matching opening-tag backreference.
- Semantic-token generation independently called the tokenizer with JSX
  disabled. Tokenization threw for the same sample and the defensive error path
  returned an empty token set, leaving TextMate as the only highlighting layer.
  VexaScript semantic-token requests now tokenize with JSX enabled by default;
  TypeScript-only angle-bracket assertion tests opt out explicitly.
- JSX attribute names had a correct TextMate scope and theme color, but the
  semantic layer did not visit JSX attributes and classified their identifier
  tokens as variables. It also gave lexical keyword categories precedence over
  AST roles, so an attribute named `class` became a type keyword. Semantic AST
  roles now take precedence and JSX value expressions are traversed normally.
  Generic `property` and `string` semantic types were still insufficient: a
  user's active theme could recolor them after the initial TextMate pass. JSX
  attribute names now use a dedicated `jsxAttribute` semantic type, while
  quoted values use TypeScript's `stringLiteral` semantic type. Both have
  explicit TextMate scope fallbacks in the VS Code manifest. Reusing
  `stringLiteral` is necessary for themes such as Dark 2026, whose ordinary
  TextMate strings are cyan but whose TypeScript string literals are orange.
  This preserves the intended JSX colors after the delayed LSP response.
- JSX component references were traversed like ordinary identifiers, so a
  component such as `Fragment` became a white variable after semantic tokens
  arrived. JSX elements now classify their callable component reference as a
  function, including the matching closing tag, while intrinsic lowercase tags
  remain under the JSX/TextMate tag color.
- Definition fallback assumed every analysis session had a non-null analysis,
  even though parse/tokenization failures explicitly produce nullable session
  artifacts. A parallel Monaco workspace test reached that valid state and
  crashed navigation. The shared fallback now returns no definition when the
  session cannot provide semantic analysis instead of dereferencing null.
- Parallel full-suite runs exposed declaration resolver crashes while loading
  React and DOM typings. The resolver assumed every declaration-shaped recovery
  node had a `name`; recovered third-party declarations can omit it while their
  parser diagnostics remain available. Declaration indexing now skips those
  nameless nodes and continues to later valid declarations.

## Investigation branches that did not work

- The intermittent declaration crash initially looked like mutation of the
  shared DOM declaration cache. Repeated cache serialization/revival checks and
  focused DOM runs preserved every top-level name. The decisive stack trace and
  a minimal recovery-node reproduction instead showed that the unsafe
  `declaration.name.name` access was the common failure point; guarding the
  declaration index fixes all affected consumers through their shared path.

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
  components/signals, shared signal state, the transitive `hooks.vx` signal
  consumer, and Vite entrypoint now verify diagnostics, hover, definitions,
  and completion against the real packages.
- Scanning only the consumer's direct package imports could not resolve this
  member: `hooks.vx` imports `tasks.vx`, while only `tasks.vx` imports Preact
  Signals. Recursively scanning packages again inside navigation would duplicate
  import analysis and still risk same-name matches. Preserving declaration
  provenance at collection time lets navigation consume the type checker's
  actual external declarations instead.
- A successful `vite build` also missed the undefined JSX factory because
  bundling validates symbol syntax, not execution. Loading the production
  transform in a browser and clicking the counter exposed the failure; the
  browser check remains an essential acceptance step for framework samples.
- After the transitive-import source fix and extension bundle were installed,
  an already-running VS Code language-server process continued executing the
  previous bundle from memory. Its process start time predated the installed
  `vexa.mjs`, so rebuilding or overwriting the VSIX alone could not update the
  active editor session. Restart the language-server process (or reload the VS
  Code window) after local extension installation, and distinguish the live
  process from the bundle on disk before reopening a solved compiler bug.
- The first highlighting inspection focused on declaration classification
  because only the later function name appeared gray. Directly invoking the
  semantic-token builder on `forms.vx` showed that it returned no tokens at all;
  inspecting the TextMate scope lifetime then revealed the independent leaked
  JSX scope. Testing both editor layers was necessary because fixing either one
  alone would leave the other regression hidden.

## Lesson

A framework sample is most valuable when it has the same import graph and type
pressure as a real application. Splitting the Preact example exposed bugs that
a single-file showcase could not reach, especially transitive inferred exports
and dependency-private declaration collisions. Keep the broad runnable sample,
but always preserve each discovered failure with a minimal compiler or LSP
regression as well.
