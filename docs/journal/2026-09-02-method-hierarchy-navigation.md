# Method hierarchy navigation

## Problem

The LSP advertised an implementation provider but routed
`textDocument/implementation` through ordinary definition lookup. Method
declarations therefore navigated back to themselves, and Find All
Implementations could not return the base declaration and sibling overrides.

## Change

Method declarations now resolve inherited class and interface edges through
the shared class resolver. Go to Definition on an overriding declaration uses
the nearest base declaration. Go to Definition on a hierarchy root instead
returns its connected overrides, which lets Cmd/Ctrl-click offer their
destinations. The implementation provider follows the same semantic edges to
their roots, scans project-owned VexaScript files, and returns the root
declaration plus every connected own implementation. It does not use a
workspace-wide same-name match.

## Regression risk

Hierarchy navigation must keep using resolved inheritance provenance and keep
its direction sensitive: an override navigates upward, while a root declaration
navigates downward. A plain name search would conflate unrelated classes,
while reusing Definition for the implementation request would silently collapse
a many-location result to one. The cross-file regression bounds project-session
requests with a work counter rather than a wall-clock threshold.

## Verification

- Regressions cover upward and downward Definition requests, local class
  hierarchies, interface implementations, an unrelated same-name method, and a
  hierarchy split across project files.
- The cross-file scenario permits at most 16 project-session requests.

## Execution metadata

- Date: 2026-09-02
- Provider: OpenAI
- Model: Unavailable (not exposed by runtime)
