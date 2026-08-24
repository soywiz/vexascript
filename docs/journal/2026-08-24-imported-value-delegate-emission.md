# Imported value-delegate emission

## Context

The website playground compiled its starter workspace successfully, printed the
pattern-matching result, and then failed at runtime when updating a delegated
variable:

```text
TypeError: __$delegate_prop[1] is not a function
```

`prop` was backed by an imported generic `LoggedProperty<T>` class whose
`value` property had a getter and setter. The emitted bundle nevertheless used
the tuple-delegate convention (`delegate[0]` and `delegate[1](value)`) instead
of the class value-property convention (`delegate.value`).

## Root cause

Semantic analysis retained the imported call's nominal `LoggedProperty` type,
but JavaScript delegate classification had a local-file-only fallback. For a
nominal type it scanned the program being emitted for a class with a `value`
getter. Imported declaration metadata was already available in the shared
runtime seed, but the fallback did not consume it. It therefore classified the
imported delegate as an unknown tuple and emitted a call to index `1`.

The existing website-workspace module-graph test only asserted that bundling
reported no compile-time errors. It did not inspect or execute the delegated
update, so invalid JavaScript passed the test.

## Fix and regression coverage

Runtime seed construction now records nominal classes that expose a `value`
getter. Delegate classification consumes that shared set for both local and
imported declarations instead of rescanning only the local program.

A focused module-graph regression test uses an imported generic class with the
same property-block syntax as the playground. It asserts that both the update
and subsequent read use `.value`. A real browser smoke test of the built
playground confirmed that the complete starter program runs without console
errors and logs both delegated changes.

## Investigation notes

The error initially appeared adjacent to `ok: pattern matching` in the compact
console output, which made the new match expression look suspect. Inspecting
the generated identifier showed that `__$delegate_prop` belonged to the later
`let prop by LoggedProperty(10)` declaration. A focused failing test then
confirmed that pattern matching was unrelated.

The standalone Playwright CLI wrapper could not start because it attempted to
resolve its package over the restricted network, and the repository did not
contain a local Playwright binary. The browser check used the already available
in-app Chromium runtime instead. Starting the website development command also
prompted to reinstall `website/node_modules`; serving the already validated
`website/_site` output with a static local server avoided changing dependencies.

## Execution metadata

- Model: GPT-5
- Provider: OpenAI
