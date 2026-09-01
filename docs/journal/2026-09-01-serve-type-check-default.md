# Serve type checking by default

## Symptom

`vexa serve` could successfully run a project while the language server showed
semantic errors. The terminal printed no diagnostics because serving selected
the transpile-only module-graph path unless `--type-check` was supplied.

## Decision and implementation

Serving now performs whole-project semantic checking by default, matching the
default behavior of `build` and `bundle`. The opt-out is explicit:
`vexa serve --no-type-check` passes `typeCheck: false` to the incremental bundle
pipeline. Programmatic `startServeSession` calls use the same checked default
while retaining `typeCheck: false` for callers that deliberately want
transpile-only serving.

Regression coverage verifies that an initial semantic error prevents the
server from starting, that the diagnostic reaches the configured reporter,
that the explicit opt-out still serves the generated bundle, and that CLI help
advertises only `--no-type-check`.

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: Unavailable (not exposed by runtime)
